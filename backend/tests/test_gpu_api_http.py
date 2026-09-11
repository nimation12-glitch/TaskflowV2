import uuid

from fastapi.testclient import TestClient
from jose import jwt

from app.database import get_db


def _client_for(db_session):
    import app.main as main_module

    main_module.app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(main_module.app)


def _auth_header(organization_id: uuid.UUID, role: str = "OWNER") -> dict:
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(organization_id), "role": role},
        "test-secret-test-secret-test-secret-32",
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_list_gpu_types_over_http(db_session, organization, gpu_type):
    client = _client_for(db_session)
    res = client.get("/compute/gpu-types", headers=_auth_header(organization.id))
    assert res.status_code == 200
    body = res.json()
    assert body["gpu_types"][0]["slug"] == "standard"
    assert body["gpu_types"][0]["gpu"] == "NVIDIA A10G"
    assert "effective_price_micros_per_hour" in body["gpu_types"][0]


def test_ssh_key_create_list_delete_over_http(db_session, organization, ssh_public_key):
    client = _client_for(db_session)
    headers = _auth_header(organization.id)

    res = client.post("/account/ssh-keys", json={"label": "laptop", "public_key": ssh_public_key}, headers=headers)
    assert res.status_code == 200
    key_id = res.json()["id"]
    assert "public_key" not in res.json()  # never returned back out

    res = client.get("/account/ssh-keys", headers=headers)
    assert len(res.json()["ssh_keys"]) == 1

    res = client.delete(f"/account/ssh-keys/{key_id}", headers=headers)
    assert res.status_code == 200


def test_rejects_missing_auth(db_session, organization):
    client = _client_for(db_session)
    res = client.get("/compute/rentals")
    assert res.status_code == 401


def test_wallet_over_http(db_session, organization):
    client = _client_for(db_session)
    res = client.get("/compute/wallet", headers=_auth_header(organization.id))
    assert res.status_code == 200
    body = res.json()
    assert body["balance_micros"] == 0
    assert body["estimated_hours_remaining_at_current_rate"] is None


def test_create_rental_over_http_full_flow(db_session, organization, gpu_type, ssh_key, monkeypatch):
    from app.compute import aws_provider
    from app.models.billing import CreditTransactionType
    from app.services import credits as credits_service

    credits_service.record_transaction(
        db_session, organization_id=organization.id, type=CreditTransactionType.PURCHASE,
        amount_micros=10_000_000, description="test funding",
    )
    db_session.commit()

    monkeypatch.setattr(aws_provider, "import_ssh_key", lambda public_key, unique_name: unique_name)
    monkeypatch.setattr(aws_provider, "launch_instance", lambda *a, **k: ("i-http-test", "pending"))

    client = _client_for(db_session)
    headers = _auth_header(organization.id)

    res = client.post(
        "/compute/rentals",
        json={
            "gpu_type_slug": gpu_type.slug,
            "storage_gb": 50,
            "ssh_key_id": str(ssh_key.id),
            "payment_mode": "pay_as_you_go",
        },
        headers=headers,
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "PROVISIONING"
    assert body["payment_mode"] == "pay_as_you_go"
    rental_id = body["id"]

    res = client.get("/compute/rentals", headers=headers)
    assert len(res.json()["rentals"]) == 1

    res = client.post(f"/compute/rentals/{rental_id}/stop", headers=headers)
    # Not RUNNING yet (still PROVISIONING in this mocked flow) — must reject, not silently no-op.
    assert res.status_code == 409
