import uuid

from fastapi.testclient import TestClient
from jose import jwt

from app.database import get_db
from app.models.org import Membership, Role

TEST_SECRET = "test-secret-test-secret-test-secret-32"


def _client_for(db_session):
    import app.main as main_module

    main_module.app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(main_module.app)


def _auth_header(organization_id: uuid.UUID, user_id: uuid.UUID, role: str) -> dict:
    token = jwt.encode(
        {"sub": str(user_id), "org_id": str(organization_id), "role": role, "is_platform_admin": False},
        TEST_SECRET, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _member(db_session, organization, role: Role) -> uuid.UUID:
    user_id = uuid.uuid4()
    db_session.add(Membership(organization_id=organization.id, user_id=user_id, role=role))
    db_session.commit()
    return user_id


def test_owner_can_grant_admin(db_session, organization):
    client = _client_for(db_session)
    owner_id = _member(db_session, organization, Role.OWNER)
    member_id = _member(db_session, organization, Role.MEMBER)
    headers = _auth_header(organization.id, owner_id, "OWNER")

    res = client.patch(f"/team/members/{member_id}/role", json={"role": "ADMIN"}, headers=headers)
    assert res.status_code == 200
    assert res.json()["role"] == "ADMIN"

    row = db_session.query(Membership).filter_by(
        organization_id=organization.id, user_id=member_id
    ).one()
    assert row.role == Role.ADMIN


def test_owner_can_demote_admin_to_member(db_session, organization):
    client = _client_for(db_session)
    owner_id = _member(db_session, organization, Role.OWNER)
    admin_id = _member(db_session, organization, Role.ADMIN)
    headers = _auth_header(organization.id, owner_id, "OWNER")

    res = client.patch(f"/team/members/{admin_id}/role", json={"role": "MEMBER"}, headers=headers)
    assert res.status_code == 200
    assert res.json()["role"] == "MEMBER"


def test_admin_cannot_change_roles(db_session, organization):
    client = _client_for(db_session)
    _member(db_session, organization, Role.OWNER)
    admin_id = _member(db_session, organization, Role.ADMIN)
    member_id = _member(db_session, organization, Role.MEMBER)
    headers = _auth_header(organization.id, admin_id, "ADMIN")

    res = client.patch(f"/team/members/{member_id}/role", json={"role": "ADMIN"}, headers=headers)
    assert res.status_code == 403


def test_member_cannot_change_roles(db_session, organization):
    client = _client_for(db_session)
    _member(db_session, organization, Role.OWNER)
    member_id = _member(db_session, organization, Role.MEMBER)
    other_id = _member(db_session, organization, Role.MEMBER)
    headers = _auth_header(organization.id, member_id, "MEMBER")

    res = client.patch(f"/team/members/{other_id}/role", json={"role": "ADMIN"}, headers=headers)
    assert res.status_code == 403


def test_cannot_grant_owner_role(db_session, organization):
    client = _client_for(db_session)
    owner_id = _member(db_session, organization, Role.OWNER)
    member_id = _member(db_session, organization, Role.MEMBER)
    headers = _auth_header(organization.id, owner_id, "OWNER")

    res = client.patch(f"/team/members/{member_id}/role", json={"role": "OWNER"}, headers=headers)
    assert res.status_code == 400


def test_owner_cannot_change_own_role(db_session, organization):
    client = _client_for(db_session)
    owner_id = _member(db_session, organization, Role.OWNER)
    headers = _auth_header(organization.id, owner_id, "OWNER")

    res = client.patch(f"/team/members/{owner_id}/role", json={"role": "ADMIN"}, headers=headers)
    assert res.status_code == 400


def test_owner_role_of_the_owner_cannot_be_changed(db_session, organization):
    client = _client_for(db_session)
    owner_id = _member(db_session, organization, Role.OWNER)
    admin_id = _member(db_session, organization, Role.ADMIN)
    headers = _auth_header(organization.id, admin_id, "ADMIN")

    # Even an admin poking the owner's row must fail — require_role rejects
    # admins before the ownership guard runs.
    res = client.patch(f"/team/members/{owner_id}/role", json={"role": "MEMBER"}, headers=headers)
    assert res.status_code == 403


def test_role_change_unknown_member_404(db_session, organization):
    client = _client_for(db_session)
    owner_id = _member(db_session, organization, Role.OWNER)
    headers = _auth_header(organization.id, owner_id, "OWNER")

    res = client.patch(f"/team/members/{uuid.uuid4()}/role", json={"role": "ADMIN"}, headers=headers)
    assert res.status_code == 404
