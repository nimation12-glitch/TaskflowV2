import uuid

from fastapi.testclient import TestClient
from jose import jwt

from app.database import get_db

TEST_SECRET = "test-secret-test-secret-test-secret-32"


def _client_for(db_session):
    import app.main as main_module

    main_module.app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(main_module.app)


def _auth_header(organization_id: uuid.UUID, role: str = "OWNER", is_platform_admin: bool | None = False) -> dict:
    claims = {"sub": str(uuid.uuid4()), "org_id": str(organization_id), "role": role}
    if is_platform_admin is not None:
        claims["is_platform_admin"] = is_platform_admin
    token = jwt.encode(claims, TEST_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


# ---------- RequestContext claim handling ----------

def test_request_context_defaults_is_platform_admin_false_when_claim_absent(monkeypatch):
    from app.auth.internal import require_context
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)
    # A token issued before this claim existed — no is_platform_admin key at all.
    old_token = jwt.encode({"sub": str(uuid.uuid4()), "org_id": str(uuid.uuid4()), "role": "OWNER"}, TEST_SECRET, algorithm="HS256")
    ctx = require_context(authorization=f"Bearer {old_token}")
    assert ctx.is_platform_admin is False


def test_request_context_reads_true_claim(monkeypatch):
    from app.auth.internal import require_context
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(uuid.uuid4()), "role": "OWNER", "is_platform_admin": True},
        TEST_SECRET, algorithm="HS256",
    )
    ctx = require_context(authorization=f"Bearer {token}")
    assert ctx.is_platform_admin is True


# ---------- GET /system/status ----------

def test_system_status_works_with_no_auth(db_session, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)

    client = _client_for(db_session)
    res = client.get("/system/status")
    assert res.status_code == 200
    assert res.json() == {"maintenance_mode_enabled": False, "maintenance_message": None}


# ---------- POST /system/maintenance auth ----------

def test_non_admin_gets_403_from_maintenance_toggle(db_session, organization, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)

    client = _client_for(db_session)
    headers = _auth_header(organization.id, is_platform_admin=False)
    res = client.post("/system/maintenance", json={"enabled": True, "message": "test"}, headers=headers)
    assert res.status_code == 403


def test_admin_can_toggle_maintenance_and_it_persists(db_session, organization, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)

    client = _client_for(db_session)
    admin_headers = _auth_header(organization.id, is_platform_admin=True)

    res = client.post(
        "/system/maintenance", json={"enabled": True, "message": "Upgrading GPU infra"}, headers=admin_headers
    )
    assert res.status_code == 200
    assert res.json()["maintenance_mode_enabled"] is True
    assert res.json()["maintenance_message"] == "Upgrading GPU infra"
    assert res.json()["updated_by_user_id"] is not None

    # Persisted — a fresh, unauthenticated read sees the same state.
    res = client.get("/system/status")
    assert res.json() == {"maintenance_mode_enabled": True, "maintenance_message": "Upgrading GPU infra"}

    res = client.post("/system/maintenance", json={"enabled": False, "message": None}, headers=admin_headers)
    assert res.status_code == 200
    assert res.json()["maintenance_mode_enabled"] is False

    res = client.get("/system/status")
    assert res.json()["maintenance_mode_enabled"] is False


# ---------- Enforcement on /compute/* (admin bypass) and /v1/* (no bypass) ----------

def test_maintenance_blocks_non_admin_on_compute_route(db_session, organization, monkeypatch):
    from app.config import get_settings
    from app.services import system as system_service

    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)
    system_service.set_maintenance_mode(db_session, enabled=True, message="down for maintenance", updated_by_user_id=uuid.uuid4())
    db_session.commit()

    client = _client_for(db_session)
    res = client.get("/compute/gpu-types", headers=_auth_header(organization.id, is_platform_admin=False))
    assert res.status_code == 503
    assert "maintenance" in res.json()["detail"].lower()


def test_maintenance_allows_admin_on_compute_route(db_session, organization, gpu_type, monkeypatch):
    from app.config import get_settings
    from app.services import system as system_service

    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)
    system_service.set_maintenance_mode(db_session, enabled=True, message="down for maintenance", updated_by_user_id=uuid.uuid4())
    db_session.commit()

    client = _client_for(db_session)
    res = client.get("/compute/gpu-types", headers=_auth_header(organization.id, is_platform_admin=True))
    assert res.status_code == 200


def test_maintenance_blocks_everyone_on_v1_gateway_including_admin(db_session, organization, monkeypatch):
    """
    Per product decision: /v1/* has no admin concept at all (it's API-key
    authenticated), so it blocks unconditionally during maintenance — even
    for a request that happens to carry an admin JWT alongside a valid key.
    """
    from app.config import get_settings
    from app.services import api_keys as api_key_service
    from app.services import system as system_service

    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)
    _, raw_key = api_key_service.generate_api_key(db_session, organization.id, uuid.uuid4(), "test key")
    db_session.commit()

    system_service.set_maintenance_mode(db_session, enabled=True, message="down for maintenance", updated_by_user_id=uuid.uuid4())
    db_session.commit()

    client = _client_for(db_session)
    res = client.get("/v1/models", headers={"Authorization": f"Bearer {raw_key}"})
    assert res.status_code == 503


def test_v1_gateway_works_normally_without_maintenance(db_session, organization, monkeypatch):
    from app.config import get_settings
    from app.services import api_keys as api_key_service

    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)
    _, raw_key = api_key_service.generate_api_key(db_session, organization.id, uuid.uuid4(), "test key")
    db_session.commit()

    client = _client_for(db_session)
    res = client.get("/v1/models", headers={"Authorization": f"Bearer {raw_key}"})
    assert res.status_code == 200


# ---------- Always-exempt routes ----------

def test_exempt_routes_reachable_during_maintenance_regardless_of_admin(db_session, organization, monkeypatch):
    from app.config import get_settings
    from app.services import system as system_service

    monkeypatch.setattr(get_settings(), "auth_secret", TEST_SECRET)
    system_service.set_maintenance_mode(db_session, enabled=True, message="down for maintenance", updated_by_user_id=uuid.uuid4())
    db_session.commit()

    client = _client_for(db_session)

    assert client.get("/health").status_code == 200
    assert client.get("/system/status").status_code == 200

    # Stripe must always be able to deliver webhooks — signature will fail
    # (no real Stripe signature provided), but it must be a 400 (bad
    # signature), never a 503 from the maintenance block.
    from app.config import get_settings as _get_settings
    monkeypatch.setattr(_get_settings(), "stripe_webhook_secret", "whsec_test_only")
    res = client.post("/webhooks/stripe", content=b"{}", headers={"stripe-signature": "invalid"})
    assert res.status_code == 400

    # The safety sweep must never be blocked by maintenance mode — a
    # forgotten rental with the sweep blocked could drain AWS spend with no
    # safety net. It's protected by its own secret, not admin status.
    res = client.post("/internal/gpu/sweep", headers={"X-Taskflow-Service-Secret": "wrong-secret-but-not-503"})
    assert res.status_code != 503
