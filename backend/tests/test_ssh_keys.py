import uuid

import pytest

from app.services import ssh_keys as ssh_key_service


def test_valid_ed25519_key_is_accepted(ssh_public_key):
    ssh_key_service.validate_public_key_format(ssh_public_key)  # should not raise


def test_valid_rsa_key_is_accepted():
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub = key.public_key().public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH).decode("ascii")
    ssh_key_service.validate_public_key_format(pub)  # should not raise


def test_private_key_is_explicitly_rejected():
    fake_private_key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1lZDI1NTE5AAAA\n-----END OPENSSH PRIVATE KEY-----"
    with pytest.raises(ssh_key_service.InvalidPublicKeyError, match="private key"):
        ssh_key_service.validate_public_key_format(fake_private_key)


def test_garbage_is_rejected():
    with pytest.raises(ssh_key_service.InvalidPublicKeyError):
        ssh_key_service.validate_public_key_format("this is not a key at all")


def test_empty_string_is_rejected():
    with pytest.raises(ssh_key_service.InvalidPublicKeyError):
        ssh_key_service.validate_public_key_format("")


def test_fingerprint_is_sha256_format(ssh_public_key):
    fp = ssh_key_service.compute_fingerprint(ssh_public_key)
    assert fp.startswith("SHA256:")


def test_create_and_list_ssh_key(db_session, organization, ssh_public_key):
    user_id = uuid.uuid4()
    key = ssh_key_service.create_ssh_key(db_session, organization.id, user_id, "My laptop", ssh_public_key)
    db_session.commit()

    keys = ssh_key_service.list_ssh_keys(db_session, organization.id)
    assert len(keys) == 1
    assert keys[0].id == key.id
    assert keys[0].fingerprint.startswith("SHA256:")


def test_tenant_isolation_on_ssh_key_lookup(db_session, organization, ssh_key):
    from app.models.org import Organization

    other_org = Organization(name="Other Org", slug=f"other-{uuid.uuid4().hex[:8]}")
    db_session.add(other_org)
    db_session.commit()

    # The other org must not be able to fetch this org's key by ID.
    assert ssh_key_service.get_org_ssh_key(db_session, other_org.id, ssh_key.id) is None
    assert ssh_key_service.get_org_ssh_key(db_session, organization.id, ssh_key.id) is not None


def test_delete_blocked_while_key_is_in_use(db_session, organization, ssh_key, gpu_type):
    from app.models.compute import GpuInstance, GpuInstanceStatus, PaymentMode

    instance = GpuInstance(
        organization_id=organization.id,
        created_by_user_id=uuid.uuid4(),
        gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id,
        status=GpuInstanceStatus.RUNNING,
        payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=100,
        hourly_rate_micros=1_400_000,
    )
    db_session.add(instance)
    db_session.commit()

    with pytest.raises(ssh_key_service.SshKeyInUseError):
        ssh_key_service.delete_ssh_key(db_session, organization.id, ssh_key.id)


def test_delete_succeeds_once_not_in_use(db_session, organization, ssh_key):
    ssh_key_service.delete_ssh_key(db_session, organization.id, ssh_key.id)
    db_session.commit()
    assert ssh_key_service.get_org_ssh_key(db_session, organization.id, ssh_key.id) is None
