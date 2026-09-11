import uuid

import pytest

from app.compute import aws_provider
from app.models.billing import CreditTransactionType
from app.models.compute import BookingDuration, GpuInstance, GpuInstanceStatus, PaymentMode
from app.models.org import Organization
from app.services import credits as credits_service
from app.services import gpu_rentals as gpu_rental_service


def _fund_wallet(db_session, org_id, amount_micros=10_000_000):
    credits_service.record_transaction(
        db_session, organization_id=org_id, type=CreditTransactionType.PURCHASE,
        amount_micros=amount_micros, description="test funding",
    )


# ---------- pricing ----------

def test_storage_addon_pricing_matches_frontend_formula(gpu_type, db_session, organization):
    plan = gpu_rental_service.get_plan_for_org(db_session, organization.id)
    # 100GB included free; 250GB -> 150GB overage -> ceil(150/100)=2 blocks * 30,000 micros
    assert gpu_rental_service.storage_add_on_micros(100) == 0
    assert gpu_rental_service.storage_add_on_micros(250) == 60_000
    assert gpu_rental_service.storage_add_on_micros(500) == 120_000

    rate = gpu_rental_service.compute_hourly_rate_micros(gpu_type, 100, plan)
    assert rate == gpu_type.price_micros_per_hour  # FREE plan: no discount, no storage addon


def test_plan_discount_applied_to_hourly_rate(db_session, organization, gpu_type):
    from app.models.billing import Plan, PlanCode
    from app.models.billing import Subscription, SubscriptionStatus

    pro = db_session.execute(
        __import__("sqlalchemy").select(Plan).where(Plan.code == PlanCode.PRO)
    ).scalar_one()
    db_session.add(Subscription(organization_id=organization.id, plan_id=pro.id, status=SubscriptionStatus.ACTIVE, cancel_at_period_end=False))
    db_session.commit()

    plan = gpu_rental_service.get_plan_for_org(db_session, organization.id)
    rate = gpu_rental_service.discounted_base_rate_micros(gpu_type, plan)
    assert rate == gpu_type.price_micros_per_hour * 9_000 // 10_000  # 10% off


# ---------- plan limit enforcement ----------

def test_concurrent_rental_limit_enforced(db_session, organization, gpu_type, ssh_key, monkeypatch):
    _fund_wallet(db_session, organization.id)
    # FREE plan allows exactly 1 concurrent rental.
    existing = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.RUNNING, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=750_000,
    )
    db_session.add(existing)
    db_session.commit()

    with pytest.raises(gpu_rental_service.ConcurrentRentalLimitError):
        gpu_rental_service.create_rental(
            db_session, organization_id=organization.id, user_id=uuid.uuid4(), org=organization,
            gpu_type_slug=gpu_type.slug, storage_gb=50, ssh_key_id=ssh_key.id,
            payment_mode=PaymentMode.PAY_AS_YOU_GO, booking_duration=None,
        )


def test_storage_limit_enforced_per_plan(db_session, organization, gpu_type, ssh_key):
    _fund_wallet(db_session, organization.id)
    # FREE plan caps storage at 50GB.
    with pytest.raises(gpu_rental_service.StorageLimitExceededError):
        gpu_rental_service.create_rental(
            db_session, organization_id=organization.id, user_id=uuid.uuid4(), org=organization,
            gpu_type_slug=gpu_type.slug, storage_gb=250, ssh_key_id=ssh_key.id,
            payment_mode=PaymentMode.PAY_AS_YOU_GO, booking_duration=None,
        )


def test_storage_must_be_one_of_allowed_options(db_session, organization, gpu_type, ssh_key):
    _fund_wallet(db_session, organization.id)
    with pytest.raises(gpu_rental_service.StorageLimitExceededError):
        gpu_rental_service.create_rental(
            db_session, organization_id=organization.id, user_id=uuid.uuid4(), org=organization,
            gpu_type_slug=gpu_type.slug, storage_gb=37, ssh_key_id=ssh_key.id,
            payment_mode=PaymentMode.PAY_AS_YOU_GO, booking_duration=None,
        )


def test_booking_rejected_for_free_plan(db_session, organization, gpu_type, ssh_key):
    with pytest.raises(gpu_rental_service.BookingNotAllowedError):
        gpu_rental_service.create_rental(
            db_session, organization_id=organization.id, user_id=uuid.uuid4(), org=organization,
            gpu_type_slug=gpu_type.slug, storage_gb=50, ssh_key_id=ssh_key.id,
            payment_mode=PaymentMode.BOOKING, booking_duration=BookingDuration.DAY,
        )


def test_insufficient_wallet_balance_rejects_rental(db_session, organization, gpu_type, ssh_key):
    # No funding at all — balance is 0.
    with pytest.raises(gpu_rental_service.InsufficientWalletBalanceError):
        gpu_rental_service.create_rental(
            db_session, organization_id=organization.id, user_id=uuid.uuid4(), org=organization,
            gpu_type_slug=gpu_type.slug, storage_gb=50, ssh_key_id=ssh_key.id,
            payment_mode=PaymentMode.PAY_AS_YOU_GO, booking_duration=None,
        )
    # Nothing should have been created.
    assert gpu_rental_service.list_org_rentals(db_session, organization.id) == []


# ---------- tenant isolation ----------

def test_cannot_rent_using_another_orgs_ssh_key(db_session, organization, gpu_type, ssh_key):
    other_org = Organization(name="Other Org", slug=f"other-{uuid.uuid4().hex[:8]}")
    db_session.add(other_org)
    db_session.commit()
    _fund_wallet(db_session, other_org.id)

    with pytest.raises(gpu_rental_service.SshKeyNotFoundError):
        gpu_rental_service.create_rental(
            db_session, organization_id=other_org.id, user_id=uuid.uuid4(), org=other_org,
            gpu_type_slug=gpu_type.slug, storage_gb=50, ssh_key_id=ssh_key.id,  # belongs to `organization`, not other_org
            payment_mode=PaymentMode.PAY_AS_YOU_GO, booking_duration=None,
        )


def test_cannot_see_or_act_on_another_orgs_rental(db_session, organization, gpu_type, ssh_key):
    other_org = Organization(name="Other Org", slug=f"other-{uuid.uuid4().hex[:8]}")
    db_session.add(other_org)
    db_session.commit()

    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.RUNNING, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=750_000,
    )
    db_session.add(instance)
    db_session.commit()

    assert gpu_rental_service.get_org_rental(db_session, other_org.id, instance.id) is None
    with pytest.raises(gpu_rental_service.RentalNotFoundError):
        gpu_rental_service.stop_rental(db_session, other_org.id, instance.id)
    with pytest.raises(gpu_rental_service.RentalNotFoundError):
        gpu_rental_service.terminate_rental(db_session, other_org.id, instance.id)


# ---------- lifecycle, AWS fully mocked ----------

def test_create_payg_rental_provisions_via_aws(db_session, organization, gpu_type, ssh_key, monkeypatch):
    _fund_wallet(db_session, organization.id)

    monkeypatch.setattr(aws_provider, "import_ssh_key", lambda public_key, unique_name: unique_name)
    monkeypatch.setattr(aws_provider, "launch_instance", lambda *a, **k: ("i-mockinstance123", "pending"))

    result = gpu_rental_service.create_rental(
        db_session, organization_id=organization.id, user_id=uuid.uuid4(), org=organization,
        gpu_type_slug=gpu_type.slug, storage_gb=50, ssh_key_id=ssh_key.id,
        payment_mode=PaymentMode.PAY_AS_YOU_GO, booking_duration=None,
    )
    assert result.checkout_url is None
    assert result.instance.status == GpuInstanceStatus.PROVISIONING
    assert result.instance.aws_instance_id == "i-mockinstance123"


def test_aws_launch_failure_marks_instance_failed_not_silently(db_session, organization, gpu_type, ssh_key, monkeypatch):
    _fund_wallet(db_session, organization.id)

    monkeypatch.setattr(aws_provider, "import_ssh_key", lambda public_key, unique_name: unique_name)

    def _boom(*a, **k):
        raise aws_provider.AwsRequestError("simulated AWS outage")

    monkeypatch.setattr(aws_provider, "launch_instance", _boom)

    with pytest.raises(gpu_rental_service.ProvisioningFailedError):
        gpu_rental_service.create_rental(
            db_session, organization_id=organization.id, user_id=uuid.uuid4(), org=organization,
            gpu_type_slug=gpu_type.slug, storage_gb=50, ssh_key_id=ssh_key.id,
            payment_mode=PaymentMode.PAY_AS_YOU_GO, booking_duration=None,
        )

    rentals = gpu_rental_service.list_org_rentals(db_session, organization.id)
    assert len(rentals) == 1
    assert rentals[0].status == GpuInstanceStatus.FAILED
    assert "simulated AWS outage" in rentals[0].error_detail


def test_stop_bills_elapsed_time_and_calls_aws(db_session, organization, gpu_type, ssh_key, monkeypatch):
    import datetime

    _fund_wallet(db_session, organization.id)
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.RUNNING, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=1_000_000, aws_instance_id="i-abc",
        last_billed_at=datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1),
    )
    db_session.add(instance)
    db_session.commit()

    stop_calls = []
    monkeypatch.setattr(aws_provider, "stop_instance", lambda iid: stop_calls.append(iid))

    balance_before = credits_service.get_or_create_account(db_session, organization.id).balance_micros
    gpu_rental_service.stop_rental(db_session, organization.id, instance.id)
    balance_after = credits_service.get_or_create_account(db_session, organization.id).balance_micros

    assert stop_calls == ["i-abc"]
    assert instance.status == GpuInstanceStatus.STOPPED
    # Billed ~1 hour — allow a tiny tolerance for wall-clock time elapsed
    # between test setup and the assertion itself.
    assert abs((balance_before - balance_after) - 1_000_000) <= 50


def test_start_rechecks_balance_and_provisions(db_session, organization, gpu_type, ssh_key, monkeypatch):
    _fund_wallet(db_session, organization.id, amount_micros=500_000)
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.STOPPED, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=1_000_000, aws_instance_id="i-abc",
    )
    db_session.add(instance)
    db_session.commit()

    # Balance (500k) doesn't cover another full hour at 1,000,000/hr.
    with pytest.raises(gpu_rental_service.InsufficientWalletBalanceError):
        gpu_rental_service.start_rental(db_session, organization.id, instance.id)

    _fund_wallet(db_session, organization.id, amount_micros=2_000_000)
    monkeypatch.setattr(aws_provider, "start_instance", lambda iid: None)
    result = gpu_rental_service.start_rental(db_session, organization.id, instance.id)
    assert result.status == GpuInstanceStatus.PROVISIONING


def test_terminate_calls_aws_and_is_terminal(db_session, organization, gpu_type, ssh_key, monkeypatch):
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.STOPPED, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=1_000_000, aws_instance_id="i-abc",
    )
    db_session.add(instance)
    db_session.commit()

    terminate_calls = []
    monkeypatch.setattr(aws_provider, "terminate_instance", lambda iid: terminate_calls.append(iid))

    result = gpu_rental_service.terminate_rental(db_session, organization.id, instance.id)
    assert terminate_calls == ["i-abc"]
    assert result.status == GpuInstanceStatus.TERMINATED

    with pytest.raises(gpu_rental_service.InvalidRentalStateError):
        gpu_rental_service.terminate_rental(db_session, organization.id, instance.id)


def test_booking_creates_pending_payment_and_checkout_url(db_session, organization, gpu_type, ssh_key, monkeypatch):
    from app.models.billing import Plan, PlanCode, Subscription, SubscriptionStatus
    from sqlalchemy import select

    pro = db_session.execute(select(Plan).where(Plan.code == PlanCode.PRO)).scalar_one()
    db_session.add(Subscription(organization_id=organization.id, plan_id=pro.id, status=SubscriptionStatus.ACTIVE, cancel_at_period_end=False))
    db_session.commit()

    from app.billing import stripe_service

    monkeypatch.setattr(stripe_service, "create_gpu_booking_checkout_session", lambda *a, **k: "https://checkout.stripe.com/fake")

    result = gpu_rental_service.create_rental(
        db_session, organization_id=organization.id, user_id=uuid.uuid4(), org=organization,
        gpu_type_slug=gpu_type.slug, storage_gb=100, ssh_key_id=ssh_key.id,
        payment_mode=PaymentMode.BOOKING, booking_duration=BookingDuration.DAY,
    )
    assert result.instance is None
    assert result.checkout_url == "https://checkout.stripe.com/fake"

    # PENDING_PAYMENT rows exist for webhook idempotency but are excluded from listings.
    all_rows = db_session.query(GpuInstance).filter_by(organization_id=organization.id).all()
    assert len(all_rows) == 1
    assert all_rows[0].status == GpuInstanceStatus.PENDING_PAYMENT
    assert gpu_rental_service.list_org_rentals(db_session, organization.id) == []
