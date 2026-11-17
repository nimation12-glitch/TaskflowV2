import uuid

from fastapi.testclient import TestClient
from jose import jwt

from app.database import get_db

TEST_SECRET = "test-secret-test-secret-test-secret-32"


def _client_for(db_session):
    import app.main as main_module

    main_module.app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(main_module.app)


def _auth_header(organization_id: uuid.UUID, is_platform_admin: bool = False) -> dict:
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(organization_id), "role": "OWNER", "is_platform_admin": is_platform_admin},
        TEST_SECRET, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_non_admin_gets_403_on_every_admin_route(db_session, organization):
    client = _client_for(db_session)
    headers = _auth_header(organization.id, is_platform_admin=False)

    assert client.get("/admin/organizations", headers=headers).status_code == 403
    assert client.get(f"/admin/organizations/{organization.id}", headers=headers).status_code == 403
    assert client.post(f"/admin/organizations/{organization.id}/credits", json={"amount_micros": 1, "reason": "x"}, headers=headers).status_code == 403
    assert client.post(f"/admin/organizations/{organization.id}/plan", json={"plan_code": "PRO"}, headers=headers).status_code == 403


def test_admin_can_list_and_view_organizations(db_session, organization, gpu_type, ssh_key):
    client = _client_for(db_session)
    admin_headers = _auth_header(organization.id, is_platform_admin=True)

    res = client.get("/admin/organizations", headers=admin_headers)
    assert res.status_code == 200
    orgs = res.json()["organizations"]
    assert any(o["id"] == str(organization.id) for o in orgs)
    this_org = next(o for o in orgs if o["id"] == str(organization.id))
    assert this_org["plan_code"] == "FREE"
    assert this_org["wallet_balance_micros"] == 0

    res = client.get(f"/admin/organizations/{organization.id}", headers=admin_headers)
    assert res.status_code == 200
    detail = res.json()
    assert "members" in detail
    assert "recent_credit_transactions" in detail


def test_admin_grant_credits_is_audited_ledger_entry(db_session, organization):
    from app.models.billing import CreditTransaction, CreditTransactionType

    client = _client_for(db_session)
    admin_headers = _auth_header(organization.id, is_platform_admin=True)

    res = client.post(
        f"/admin/organizations/{organization.id}/credits",
        json={"amount_micros": 5_000_000, "reason": "Support credit — refund for downtime"},
        headers=admin_headers,
    )
    assert res.status_code == 200
    assert res.json()["new_balance_micros"] == 5_000_000

    txn = db_session.query(CreditTransaction).filter_by(organization_id=organization.id).one()
    assert txn.type == CreditTransactionType.ADJUSTMENT
    assert "Support credit" in txn.description


def test_admin_grant_credits_requires_a_reason(db_session, organization):
    client = _client_for(db_session)
    admin_headers = _auth_header(organization.id, is_platform_admin=True)
    res = client.post(
        f"/admin/organizations/{organization.id}/credits",
        json={"amount_micros": 5_000_000, "reason": "   "},
        headers=admin_headers,
    )
    assert res.status_code == 400


def test_admin_can_force_change_plan(db_session, organization):
    client = _client_for(db_session)
    admin_headers = _auth_header(organization.id, is_platform_admin=True)

    res = client.post(f"/admin/organizations/{organization.id}/plan", json={"plan_code": "MAX"}, headers=admin_headers)
    assert res.status_code == 200
    assert res.json()["plan_code"] == "MAX"

    # Persisted.
    res = client.get(f"/admin/organizations/{organization.id}", headers=admin_headers)
    assert res.json()["plan_code"] == "MAX"


def test_admin_routes_404_for_unknown_organization(db_session, organization):
    client = _client_for(db_session)
    admin_headers = _auth_header(organization.id, is_platform_admin=True)
    fake_id = str(uuid.uuid4())
    assert client.get(f"/admin/organizations/{fake_id}", headers=admin_headers).status_code == 404
    assert client.post(f"/admin/organizations/{fake_id}/credits", json={"amount_micros": 1, "reason": "x"}, headers=admin_headers).status_code == 404


def test_admin_users_directory_groups_memberships_by_user(db_session, organization):
    from app.models.org import Membership, Role

    client = _client_for(db_session)
    admin_headers = _auth_header(organization.id, is_platform_admin=True)

    user_a = uuid.uuid4()
    user_b = uuid.uuid4()
    db_session.add_all(
        [
            Membership(organization_id=organization.id, user_id=user_a, role=Role.OWNER),
            Membership(organization_id=organization.id, user_id=user_b, role=Role.MEMBER),
        ]
    )
    db_session.commit()

    res = client.get("/admin/users", headers=admin_headers)
    assert res.status_code == 200
    users = {u["user_id"]: u for u in res.json()["users"]}
    assert users[str(user_a)]["organizations"][0]["role"] == "OWNER"
    assert users[str(user_a)]["organizations"][0]["name"] == "Test Org"
    assert users[str(user_b)]["organizations"][0]["role"] == "MEMBER"


def test_admin_users_directory_requires_platform_admin(db_session, organization):
    client = _client_for(db_session)
    headers = _auth_header(organization.id, is_platform_admin=False)
    assert client.get("/admin/users", headers=headers).status_code == 403
