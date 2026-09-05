from fastapi.testclient import TestClient

from app.billing import stripe_service


def test_idempotency_marks_and_detects_processed_events(db_session):
    assert stripe_service.already_processed(db_session, "evt_123") is False
    stripe_service.mark_processed(db_session, "evt_123", "invoice.paid", {"id": "evt_123"})
    db_session.commit()
    assert stripe_service.already_processed(db_session, "evt_123") is True


def test_webhook_endpoint_rejects_missing_signature(monkeypatch):
    import app.main as main_module

    client = TestClient(main_module.app)
    res = client.post("/webhooks/stripe", content=b"{}")
    assert res.status_code == 400


def test_webhook_endpoint_rejects_invalid_signature(monkeypatch):
    import app.main as main_module
    from app.config import get_settings

    get_settings().stripe_webhook_secret = "whsec_test_only"

    client = TestClient(main_module.app)
    res = client.post("/webhooks/stripe", content=b"{}", headers={"stripe-signature": "t=1,v1=invalid"})
    assert res.status_code == 400
