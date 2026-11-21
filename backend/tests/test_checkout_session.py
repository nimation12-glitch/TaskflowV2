"""
GET /billing/checkout/session — the payload the branded /checkout page renders.

The endpoint's entire security story is "a session id is not a capability":
whatever id the browser hands over, the response is scoped to the caller's
organization and a foreign or malformed id reports 404 rather than confirming
that somebody else's payment exists. These tests pin that down, along with the
pence → micro-GBP conversion every money figure on the page depends on.
"""

import uuid

from fastapi.testclient import TestClient
from jose import jwt

SESSION_ID = "cs_test_a0DeZvKisaI0iu124ZLGuM05kFU1u3skcD4V75GkVMVuykzRY2KoURYEj7"


def _client_for(db_session):
    import app.main as main_module
    from app.database import get_db

    main_module.app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(main_module.app)


def _auth_header(organization_id, role: str = "OWNER") -> dict:
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(organization_id), "role": role},
        "test-secret-test-secret-test-secret-32",
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _stub_stripe(
    monkeypatch, *, organization_id, amount_total=2500, mode="payment", metadata_extra=None, items=None
):
    """Replace the two Stripe reads the endpoint makes with fixed fixtures."""
    import stripe

    metadata = {"organization_id": str(organization_id), "purchase_type": "wallet_topup"}
    metadata.update(metadata_extra or {})

    session = {
        "id": SESSION_ID,
        "client_secret": "cs_secret_abc",
        "mode": mode,
        "status": "open",
        "payment_status": "unpaid",
        "currency": "gbp",
        "amount_total": amount_total,
        "metadata": metadata,
    }
    line_items = items if items is not None else [
        {"description": "GPU wallet top-up", "amount_total": amount_total}
    ]

    monkeypatch.setattr(stripe.checkout.Session, "retrieve", lambda *a, **k: dict(session))
    monkeypatch.setattr(
        stripe.checkout.Session, "list_line_items", lambda *a, **k: {"data": line_items}
    )


def test_checkout_session_returns_summary_for_own_organization(db_session, organization, monkeypatch):
    _stub_stripe(monkeypatch, organization_id=organization.id, amount_total=2500)
    client = _client_for(db_session)

    res = client.get(
        f"/billing/checkout/session?session_id={SESSION_ID}",
        headers=_auth_header(organization.id),
    )

    assert res.status_code == 200
    body = res.json()
    assert body["session_id"] == SESSION_ID
    assert body["client_secret"] == "cs_secret_abc"
    assert body["mode"] == "payment"
    assert body["payment_status"] == "unpaid"
    assert body["currency"] == "gbp"
    # Stripe quotes pence; the product speaks micro-GBP (2500p = £25).
    assert body["total_micros"] == 25_000_000
    assert body["items"] == [{"name": "GPU wallet top-up", "amount_micros": 25_000_000}]
    assert body["title"] == "Top up your GPU wallet"
    assert body["purchase_type"] == "wallet_topup"


def test_checkout_session_is_not_a_capability(db_session, organization, monkeypatch):
    """A session belonging to another org must read as missing, not forbidden."""
    _stub_stripe(monkeypatch, organization_id=uuid.uuid4())
    client = _client_for(db_session)

    res = client.get(
        f"/billing/checkout/session?session_id={SESSION_ID}",
        headers=_auth_header(organization.id),
    )

    assert res.status_code == 404
    assert "organization" not in res.json()["detail"].lower()


def test_checkout_session_rejects_malformed_id(db_session, organization):
    client = _client_for(db_session)

    res = client.get(
        "/billing/checkout/session?session_id=not-a-session",
        headers=_auth_header(organization.id),
    )

    assert res.status_code == 400


def test_checkout_session_titles_subscription_purchases(db_session, organization, monkeypatch):
    _stub_stripe(
        monkeypatch,
        organization_id=organization.id,
        amount_total=3000,
        mode="subscription",
        metadata_extra={"purchase_type": "subscription", "plan": "PRO"},
        items=[{"description": "Taskflow Pro", "amount_total": 3000}],
    )
    client = _client_for(db_session)

    res = client.get(
        f"/billing/checkout/session?session_id={SESSION_ID}",
        headers=_auth_header(organization.id),
    )

    assert res.status_code == 200
    body = res.json()
    assert body["title"] == "Taskflow PRO plan"
    assert body["mode"] == "subscription"
    assert body["plan"] == "PRO"
    assert body["total_micros"] == 30_000_000


def test_checkout_session_requires_auth(db_session, organization):
    client = _client_for(db_session)

    res = client.get(f"/billing/checkout/session?session_id={SESSION_ID}")

    assert res.status_code in (401, 403)
