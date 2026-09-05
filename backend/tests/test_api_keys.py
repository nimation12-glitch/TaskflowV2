import uuid

from app.models.api_key import ApiKeyStatus
from app.services import api_keys as api_key_service


def test_generated_key_has_expected_prefix(db_session, organization):
    row, raw_key = api_key_service.generate_api_key(db_session, organization.id, uuid.uuid4(), "test key")
    assert raw_key.startswith("tf_live_")
    assert row.prefix == raw_key[:12]


def test_raw_key_is_never_stored(db_session, organization):
    row, raw_key = api_key_service.generate_api_key(db_session, organization.id, uuid.uuid4(), "test key")
    assert raw_key not in row.key_hash
    assert row.key_hash != raw_key


def test_authenticate_valid_key_succeeds(db_session, organization):
    _, raw_key = api_key_service.generate_api_key(db_session, organization.id, uuid.uuid4(), "test key")
    authenticated = api_key_service.authenticate_api_key(db_session, raw_key)
    assert authenticated is not None
    assert authenticated.organization_id == organization.id


def test_authenticate_wrong_key_fails(db_session, organization):
    api_key_service.generate_api_key(db_session, organization.id, uuid.uuid4(), "test key")
    assert api_key_service.authenticate_api_key(db_session, "tf_live_wrongvalue") is None


def test_revoked_key_cannot_authenticate(db_session, organization):
    row, raw_key = api_key_service.generate_api_key(db_session, organization.id, uuid.uuid4(), "test key")
    api_key_service.revoke_api_key(db_session, organization.id, row.id)
    assert row.status == ApiKeyStatus.REVOKED
    assert api_key_service.authenticate_api_key(db_session, raw_key) is None


def test_revoke_from_wrong_organization_fails(db_session, organization):
    row, _ = api_key_service.generate_api_key(db_session, organization.id, uuid.uuid4(), "test key")
    other_org_id = uuid.uuid4()
    assert api_key_service.revoke_api_key(db_session, other_org_id, row.id) is False
