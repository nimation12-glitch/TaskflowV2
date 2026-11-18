"""
Phase 2: workspace + persistent storage entitlements and billing.

Covers the spec rules end to end at the service level (the API layer is thin
mapping), plus a couple of HTTP tests over the real router:
- workspace slots are hard account-level limits, released by delete (§25)
- the per-plan storage size matrix + included-size entitlement (§7)
- included sizes are never billed; paid sizes are (hourly while the
  workspace exists, or one-off 30-day prepaid from the wallet)
- prepaid expiry reverts to hourly in the sweep (data never destroyed)
- wallet-empty workspaces are flagged overdue, never auto-deleted
- one active GPU rental per workspace; delete blocked while attached (§22)
- tenant isolation on every fetch/mutation
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import select

from app.models.billing import (
    CreditTransaction,
    CreditTransactionType,
    Plan,
    PlanCode,
    Subscription,
    SubscriptionStatus,
)
from app.models.compute import GpuInstance, GpuInstanceStatus, PaymentMode
from app.models.workspace import StorageBillingMode, StorageSize, Workspace, WorkspaceStatus
from app.services import credits as credits_service
from app.services import workspace_storage
from app.services import workspaces as ws


def _top_up(db, organization_id, amount_micros):
    credits_service.record_transaction(
        db,
        organization_id=organization_id,
        type=CreditTransactionType.PURCHASE,
        amount_micros=amount_micros,
        description="test top-up",
    )


def _add_size(db, size_gb, hourly, prepaid, plans, enabled=True):
    row = StorageSize(
        size_gb=size_gb,
        display_name=f"{size_gb} GB",
        hourly_price_micros=hourly,
        prepaid_price_micros=prepaid,
        available_plans=plans,
        enabled=enabled,
    )
    db.add(row)
    db.commit()
    return row


def _make_workspace(db, org, *, size_gb=1024, rate=140_000, mode=StorageBillingMode.HOURLY,
                    prepaid_expires_at=None, last_billed_at=None):
    w = Workspace(
        id=uuid.uuid4(),
        organization_id=org.id,
        created_by_user_id=uuid.uuid4(),
        name=f"ws-{uuid.uuid4().hex[:6]}",
        storage_size_gb=size_gb,
        hourly_rate_micros=rate,
        billing_mode=mode,
        status=WorkspaceStatus.ACTIVE,
        prepaid_expires_at=prepaid_expires_at,
        last_billed_at=last_billed_at or datetime.now(timezone.utc),
    )
    db.add(w)
    db.commit()
    return w


@pytest.fixture()
def pro_org(db_session, organization):
    """The organization on a Pro-like plan: 5 slots, 500 GB included."""
    plan = db_session.execute(select(Plan).where(Plan.code == PlanCode.PRO)).scalar_one()
    plan.included_workspaces = 5
    plan.workspace_storage_gb = 500
    db_session.add(
        Subscription(
            organization_id=organization.id, plan_id=plan.id, status=SubscriptionStatus.ACTIVE
        )
    )
    db_session.commit()
    return organization


def _plan_of(db, org):
    return ws.get_plan_for_org(db, org.id)


# ---------------------------------------------------------------- entitlements


def test_included_size_is_free_and_never_billed(db_session, pro_org):
    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="projects", storage_size_gb=500,
    )
    # Included entitlement: snapshotted rate is 0 and nothing is ever charged,
    # even with hours elapsed and the catalogue row still disabled.
    assert w.hourly_rate_micros == 0
    w.last_billed_at = datetime.now(timezone.utc) - timedelta(hours=5)
    db_session.commit()
    assert workspace_storage.bill_workspace_storage(db_session, w) is False
    assert w.total_charged_micros == 0
    assert w.payment_overdue_at is None
    assert (
        db_session.execute(
            select(CreditTransaction).where(CreditTransaction.workspace_id == w.id)
        ).scalars().all()
        == []
    )


def test_included_size_cannot_be_prepaid(db_session, pro_org):
    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    with pytest.raises(ws.InvalidWorkspaceStateError):
        ws.create_workspace(
            db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
            name="projects", storage_size_gb=500, billing_mode=StorageBillingMode.PREPAID_30D,
        )


def test_slot_limit_is_hard_and_delete_releases_it(db_session, pro_org):
    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    for i in range(5):
        ws.create_workspace(
            db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
            name=f"w{i}", storage_size_gb=500,
        )
    with pytest.raises(ws.WorkspaceSlotLimitError):
        ws.create_workspace(
            db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
            name="w6", storage_size_gb=500,
        )
    # Deleting releases the slot (spec §25).
    rows = ws.list_org_workspaces(db_session, pro_org.id)
    ws.delete_workspace(db_session, pro_org.id, rows[0].id)
    assert ws.count_active_workspaces(db_session, pro_org.id) == 4
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w6", storage_size_gb=500,
    )
    assert w.status == WorkspaceStatus.ACTIVE


def test_size_matrix_and_enabled_gate(db_session, pro_org):
    # Not offered on Pro (Free-only size).
    _add_size(db_session, 100, hourly=20_000, prepaid=9_990_000, plans=["FREE"])
    with pytest.raises(ws.StorageSizeNotOfferedError):
        ws.create_workspace(
            db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
            name="w", storage_size_gb=100,
        )
    # Offered on Pro but not enabled for paid use yet.
    _add_size(db_session, 1024, hourly=140_000, prepaid=69_990_000, plans=["PRO", "ULTRA", "MAX"], enabled=False)
    with pytest.raises(ws.StorageSizeNotAvailableError):
        ws.create_workspace(
            db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
            name="w", storage_size_gb=1024,
        )
    # Enabled -> creatable, with the fixed catalogue rate snapshotted.
    _top_up(db_session, pro_org.id, 1_000_000)
    row = db_session.execute(select(StorageSize).where(StorageSize.size_gb == 1024)).scalar_one()
    row.enabled = True
    db_session.commit()
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w", storage_size_gb=1024,
    )
    assert w.hourly_rate_micros == 140_000


def test_paid_hourly_requires_wallet_reserve(db_session, pro_org):
    _add_size(db_session, 1024, hourly=140_000, prepaid=69_990_000, plans=["PRO", "ULTRA", "MAX"])
    with pytest.raises(ws.InsufficientWalletBalanceError):
        ws.create_workspace(
            db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
            name="w", storage_size_gb=1024,
        )
    _top_up(db_session, pro_org.id, 140_000 - 1)
    with pytest.raises(ws.InsufficientWalletBalanceError):
        ws.create_workspace(
            db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
            name="w", storage_size_gb=1024,
        )
    _top_up(db_session, pro_org.id, 1)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w", storage_size_gb=1024,
    )
    # Hourly creation reserves nothing — it only requires 1h of cover.
    assert w.total_charged_micros == 0


# ---------------------------------------------------------------- billing


def test_prepaid_draws_wallet_once(db_session, pro_org):
    _add_size(db_session, 1024, hourly=140_000, prepaid=69_990_000, plans=["PRO", "ULTRA", "MAX"])
    _top_up(db_session, pro_org.id, 69_990_000)
    before = datetime.now(timezone.utc)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w", storage_size_gb=1024, billing_mode=StorageBillingMode.PREPAID_30D,
    )
    account = credits_service.get_or_create_account(db_session, pro_org.id)
    assert account.balance_micros == 0
    txns = (
        db_session.execute(
            select(CreditTransaction).where(CreditTransaction.workspace_id == w.id)
        ).scalars().all()
    )
    assert len(txns) == 1
    assert txns[0].type == CreditTransactionType.STORAGE_PREPAID
    assert txns[0].amount_micros == -69_990_000
    assert w.prepaid_expires_at - before > timedelta(days=29, hours=23)
    # Prepaid workspaces are not metered hourly.
    w.last_billed_at = datetime.now(timezone.utc) - timedelta(hours=3)
    assert workspace_storage.bill_workspace_storage(db_session, w) is False
    assert w.total_charged_micros == 0


def test_hourly_accrual_partial_charge_flags_overdue(db_session, pro_org):
    _add_size(db_session, 1024, hourly=140_000, prepaid=69_990_000, plans=["PRO", "ULTRA", "MAX"])
    _top_up(db_session, pro_org.id, 140_000)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w", storage_size_gb=1024,
    )
    # 2h elapsed, wallet covers only 1h -> partial charge + overdue flag.
    w.last_billed_at = datetime.now(timezone.utc) - timedelta(hours=2)
    db_session.commit()
    assert workspace_storage.bill_workspace_storage(db_session, w) is True
    account = credits_service.get_or_create_account(db_session, pro_org.id)
    assert account.balance_micros == 0
    assert w.total_charged_micros == 140_000
    assert w.payment_overdue_at is not None
    # Storage is never auto-deleted for debt — the row stays ACTIVE.
    assert w.status == WorkspaceStatus.ACTIVE

    # A later fully-covered charge clears the flag.
    _top_up(db_session, pro_org.id, 200_000)
    w.last_billed_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db_session.commit()
    assert workspace_storage.bill_workspace_storage(db_session, w) is True
    assert w.payment_overdue_at is None
    assert w.total_charged_micros == 280_000


def test_sweep_bills_hourly_and_reverts_expired_prepaid(db_session, pro_org):
    now = datetime.now(timezone.utc)
    _top_up(db_session, pro_org.id, 1_000_000)
    hourly = _make_workspace(db_session, pro_org, last_billed_at=now - timedelta(hours=2))
    expired = _make_workspace(
        db_session, pro_org, mode=StorageBillingMode.PREPAID_30D,
        prepaid_expires_at=now - timedelta(hours=1),
    )
    active_prepaid = _make_workspace(
        db_session, pro_org, mode=StorageBillingMode.PREPAID_30D,
        prepaid_expires_at=now + timedelta(days=10),
    )
    result = workspace_storage.run_storage_sweep(db_session)
    assert result.checked == 3
    assert result.billed == 1  # only the hourly one had anything to charge
    assert hourly.total_charged_micros == 280_000
    assert expired.billing_mode == StorageBillingMode.HOURLY  # reverted
    assert expired.prepaid_expires_at is None
    assert active_prepaid.billing_mode == StorageBillingMode.PREPAID_30D  # untouched
    assert active_prepaid.prepaid_expires_at is not None


# ---------------------------------------------------------------- lifecycle


def test_resize_rules(db_session, pro_org):
    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    _add_size(db_session, 1024, hourly=140_000, prepaid=69_990_000, plans=["PRO", "ULTRA", "MAX"])
    _add_size(db_session, 2048, hourly=270_000, prepaid=134_990_000, plans=["PRO", "ULTRA", "MAX"])
    _top_up(db_session, pro_org.id, 500_000)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w", storage_size_gb=1024,
    )
    # Not on the plan matrix.
    with pytest.raises(ws.StorageSizeNotOfferedError):
        ws.resize_workspace(db_session, pro_org.id, w.id, 100)
    # Re-price 1024 -> 2048.
    w.last_billed_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db_session.commit()
    ws.resize_workspace(db_session, pro_org.id, w.id, 2048)
    assert w.storage_size_gb == 2048
    assert w.hourly_rate_micros == 270_000
    assert w.last_billed_at > datetime.now(timezone.utc) - timedelta(minutes=1)
    # Back down to the included size -> free again.
    ws.resize_workspace(db_session, pro_org.id, w.id, 500)
    assert w.hourly_rate_micros == 0
    # Prepaid workspaces can't resize.
    prepaid = _make_workspace(
        db_session, pro_org, mode=StorageBillingMode.PREPAID_30D,
        prepaid_expires_at=datetime.now(timezone.utc) + timedelta(days=10),
    )
    with pytest.raises(ws.InvalidWorkspaceStateError):
        ws.resize_workspace(db_session, pro_org.id, prepaid.id, 500)


def test_buy_prepaid_from_hourly(db_session, pro_org):
    _add_size(db_session, 1024, hourly=140_000, prepaid=69_990_000, plans=["PRO", "ULTRA", "MAX"])
    _top_up(db_session, pro_org.id, 69_990_000 + 140_000)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w", storage_size_gb=1024,
    )
    w.last_billed_at = datetime.now(timezone.utc) - timedelta(hours=1)
    db_session.commit()
    ws.buy_prepaid(db_session, pro_org.id, w.id)
    assert w.billing_mode == StorageBillingMode.PREPAID_30D
    assert w.prepaid_expires_at is not None
    # Settled the outstanding hour (140_000) AND drew the prepaid price.
    account = credits_service.get_or_create_account(db_session, pro_org.id)
    assert account.balance_micros == 0
    assert w.total_charged_micros == 140_000
    with pytest.raises(ws.InvalidWorkspaceStateError):
        ws.buy_prepaid(db_session, pro_org.id, w.id)


def test_delete_blocked_with_active_rental(db_session, pro_org, gpu_type, ssh_key):
    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w", storage_size_gb=500,
    )
    rental = GpuInstance(
        organization_id=pro_org.id,
        created_by_user_id=uuid.uuid4(),
        gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id,
        workspace_id=w.id,
        status=GpuInstanceStatus.RUNNING,
        payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50,
        hourly_rate_micros=1_400_000,
    )
    db_session.add(rental)
    db_session.commit()
    with pytest.raises(ws.WorkspaceHasActiveRentalError):
        ws.delete_workspace(db_session, pro_org.id, w.id)
    rental.status = GpuInstanceStatus.TERMINATED
    db_session.commit()
    ws.delete_workspace(db_session, pro_org.id, w.id)
    assert w.status == WorkspaceStatus.DELETED
    assert w.deleted_at is not None


def test_tenant_isolation(db_session, pro_org, organization):
    from app.models.org import Organization

    other = Organization(name="Other", slug=f"other-{uuid.uuid4().hex[:8]}")
    db_session.add(other)
    db_session.commit()
    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="mine", storage_size_gb=500,
    )
    assert ws.get_org_workspace(db_session, other.id, w.id) is None
    with pytest.raises(ws.WorkspaceNotFoundError):
        ws.delete_workspace(db_session, other.id, w.id)
    with pytest.raises(ws.WorkspaceNotFoundError):
        ws.resize_workspace(db_session, other.id, w.id, 500)


# ---------------------------------------------------------------- rental wiring


def test_rental_attaches_to_workspace_and_inherits_ssh_key(db_session, pro_org, gpu_type, ssh_key):
    from unittest.mock import patch

    from app.services import gpu_rentals

    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    w = ws.create_workspace(
        db_session, organization_id=pro_org.id, user_id=uuid.uuid4(),
        name="w", storage_size_gb=500, ssh_key_id=ssh_key.id,
    )
    _top_up(db_session, pro_org.id, 1_400_000)

    with patch("app.compute.aws_provider.launch_instance") as launch, patch(
        "app.compute.aws_provider.import_ssh_key"
    ) as import_key:
        launch.return_value = ("i-123", "pending", "eu-west-2a")
        import_key.return_value = f"taskflow-{uuid.uuid4().hex[:8]}"
        result = gpu_rentals.create_rental(
            db_session,
            organization_id=pro_org.id,
            user_id=uuid.uuid4(),
            org=None,  # only used for booking-mode Stripe checkout; PAYG path ignores it
            gpu_type_slug="standard",
            storage_gb=50,
            ssh_key_id=None,  # inherited from the workspace
            payment_mode=PaymentMode.PAY_AS_YOU_GO,
            booking_duration=None,
            workspace_id=w.id,
        )
    assert result.instance.workspace_id == w.id
    assert result.instance.ssh_key_id == ssh_key.id

    # Multiple active rentals may share one workspace — a workspace is
    # persistent storage + SSH identity, not a lock (multi-GPU orders).
    with patch("app.compute.aws_provider.launch_instance") as launch, patch(
        "app.compute.aws_provider.import_ssh_key"
    ) as import_key:
        launch.return_value = ("i-124", "pending", "eu-west-2a")
        import_key.return_value = f"taskflow-{uuid.uuid4().hex[:8]}"
        result2 = gpu_rentals.create_rental(
            db_session,
            organization_id=pro_org.id,
            user_id=uuid.uuid4(),
            org=None,
            gpu_type_slug="standard",
            storage_gb=50,
            ssh_key_id=None,
            payment_mode=PaymentMode.PAY_AS_YOU_GO,
            booking_duration=None,
            workspace_id=w.id,
        )
    assert result2.instance.workspace_id == w.id
    assert result2.instance.id != result.instance.id

    # A workspace-less rental still requires an explicit SSH key.
    with pytest.raises(gpu_rentals.SshKeyNotFoundError):
        gpu_rentals.create_rental(
            db_session,
            organization_id=pro_org.id,
            user_id=uuid.uuid4(),
            org=None,
            gpu_type_slug="standard",
            storage_gb=50,
            ssh_key_id=None,
            payment_mode=PaymentMode.PAY_AS_YOU_GO,
            booking_duration=None,
        )


# ---------------------------------------------------------------- HTTP


def _client_for(db_session):
    import app.main as main_module

    main_module.app.dependency_overrides[get_db_override()] = lambda: db_session
    return TestClient(main_module.app)


def get_db_override():
    from app.database import get_db

    return get_db


def _auth_header(organization_id: uuid.UUID, role: str = "OWNER") -> dict:
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(organization_id), "role": role},
        "test-secret-test-secret-test-secret-32",
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_workspace_flow_over_http(db_session, pro_org):
    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    _add_size(db_session, 1024, hourly=140_000, prepaid=69_990_000, plans=["PRO", "ULTRA", "MAX"])
    _top_up(db_session, pro_org.id, 200_000)
    client = _client_for(db_session)
    headers = _auth_header(pro_org.id)

    # Catalogue shows the included size (free) + the enabled paid size.
    res = client.get("/workspaces/catalogue/storage", headers=headers)
    assert res.status_code == 200
    sizes = res.json()["sizes"]
    assert [s["size_gb"] for s in sizes] == [500, 1024]
    assert sizes[0]["is_included"] is True and sizes[0]["hourly_price_micros"] == 0
    assert sizes[1]["is_included"] is False and sizes[1]["hourly_price_micros"] == 140_000

    res = client.post(
        "/workspaces", json={"name": "projects", "storage_size_gb": 500}, headers=headers
    )
    assert res.status_code == 200
    body = res.json()
    assert body["is_included"] is True
    assert body["hourly_rate_micros"] == 0
    ws_id = body["id"]

    res = client.get("/workspaces", headers=headers)
    assert res.status_code == 200
    assert res.json()["slots"] == {"used": 1, "included": 5}
    assert len(res.json()["workspaces"]) == 1

    res = client.delete(f"/workspaces/{ws_id}", headers=headers)
    assert res.status_code == 200
    assert res.json()["status"] == "DELETED"
    res = client.get("/workspaces", headers=headers)
    assert res.json()["slots"]["used"] == 0


def test_workspace_slot_conflict_over_http(db_session, pro_org):
    _add_size(db_session, 500, hourly=70_000, prepaid=34_990_000, plans=["PRO", "ULTRA"], enabled=False)
    plan = _plan_of(db_session, pro_org)
    plan.included_workspaces = 1
    db_session.commit()
    client = _client_for(db_session)
    headers = _auth_header(pro_org.id)
    res = client.post("/workspaces", json={"name": "a", "storage_size_gb": 500}, headers=headers)
    assert res.status_code == 200
    res = client.post("/workspaces", json={"name": "b", "storage_size_gb": 500}, headers=headers)
    assert res.status_code == 409


def test_workspace_requires_auth(db_session, pro_org):
    client = _client_for(db_session)
    assert client.get("/workspaces").status_code == 401
