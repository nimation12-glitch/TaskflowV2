"""
SSH key management for GPU rentals. Public keys are validated server-side
with `cryptography` (never a naive regex) before being trusted anywhere —
see validate_public_key_format(). AWS import is lazy (see aws_provider.import_ssh_key),
cached onto SshKey.aws_key_pair_name the first time a key is actually used
in a rental, not at creation time.
"""
from __future__ import annotations

import base64
import hashlib
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.compute import GpuInstance, GpuInstanceStatus, SshKey

# Statuses that mean the underlying AWS resources still exist (or might soon)
# and therefore still need this SSH key. PENDING_PAYMENT is included even
# though nothing is provisioned yet, since a paid booking may provision
# imminently and reference this key.
_KEY_IN_USE_STATUSES = (
    GpuInstanceStatus.PENDING_PAYMENT,
    GpuInstanceStatus.PROVISIONING,
    GpuInstanceStatus.RUNNING,
    GpuInstanceStatus.STOPPING,
    GpuInstanceStatus.STOPPED,
    GpuInstanceStatus.TERMINATING,
)


class InvalidPublicKeyError(Exception):
    pass


class SshKeyInUseError(Exception):
    pass


_PRIVATE_KEY_MARKER = re.compile(r"PRIVATE KEY", re.IGNORECASE)


def validate_public_key_format(raw: str) -> None:
    """
    Raises InvalidPublicKeyError with a clear message if `raw` is not a valid
    ssh-rsa/ssh-ed25519/ecdsa-sha2-* public key. Explicitly rejects anything
    that looks like a private key rather than silently accepting and failing
    later at AWS import time.
    """
    trimmed = raw.strip()
    if not trimmed:
        raise InvalidPublicKeyError("Public key is empty")
    if _PRIVATE_KEY_MARKER.search(trimmed):
        raise InvalidPublicKeyError(
            "This looks like a private key, not a public key. Paste the contents "
            "of your .pub file instead — never share a private key with anyone."
        )

    from cryptography.exceptions import UnsupportedAlgorithm
    from cryptography.hazmat.primitives.serialization import load_ssh_public_key

    try:
        load_ssh_public_key(trimmed.encode("utf-8"))
    except (ValueError, UnsupportedAlgorithm) as exc:
        raise InvalidPublicKeyError(
            "This doesn't look like a valid public key. It should start with "
            "ssh-rsa, ssh-ed25519, or ecdsa-sha2-*."
        ) from exc


def compute_fingerprint(raw: str) -> str:
    """
    Standard OpenSSH SHA256 fingerprint format, e.g. 'SHA256:abcd...' — matches
    `ssh-keygen -lf key.pub -E sha256` output. Computed from the key's own
    base64 wire-format field, not a re-serialization.
    """
    parts = raw.strip().split()
    if len(parts) < 2:
        raise InvalidPublicKeyError("Malformed public key")
    key_blob = base64.b64decode(parts[1])
    digest = hashlib.sha256(key_blob).digest()
    b64_digest = base64.b64encode(digest).decode("ascii").rstrip("=")
    return f"SHA256:{b64_digest}"


def list_ssh_keys(db: Session, organization_id: uuid.UUID) -> list[SshKey]:
    return list(
        db.execute(
            select(SshKey).where(SshKey.organization_id == organization_id).order_by(SshKey.created_at.desc())
        ).scalars()
    )


def create_ssh_key(
    db: Session, organization_id: uuid.UUID, created_by_user_id: uuid.UUID, label: str, public_key: str
) -> SshKey:
    validate_public_key_format(public_key)
    fingerprint = compute_fingerprint(public_key)

    row = SshKey(
        organization_id=organization_id,
        created_by_user_id=created_by_user_id,
        label=label,
        public_key=public_key.strip(),
        fingerprint=fingerprint,
        aws_key_pair_name=None,
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.flush()
    return row


def get_org_ssh_key(db: Session, organization_id: uuid.UUID, ssh_key_id: uuid.UUID) -> SshKey | None:
    """Tenant-scoped lookup — never fetch an SshKey by ID alone."""
    return db.execute(
        select(SshKey).where(SshKey.id == ssh_key_id, SshKey.organization_id == organization_id)
    ).scalar_one_or_none()


def delete_ssh_key(db: Session, organization_id: uuid.UUID, ssh_key_id: uuid.UUID) -> SshKey:
    """
    Raises SshKeyInUseError if any non-terminated/failed GpuInstance still
    references this key. Caller is responsible for calling
    aws_provider.delete_ssh_key() and committing after this returns —
    kept out of this function so tests can exercise the DB-only path
    without touching AWS (the API route wires both together).
    """
    row = get_org_ssh_key(db, organization_id, ssh_key_id)
    if row is None:
        raise LookupError("SSH key not found")

    in_use = db.execute(
        select(GpuInstance.id).where(
            GpuInstance.ssh_key_id == ssh_key_id,
            GpuInstance.status.in_(_KEY_IN_USE_STATUSES),
        )
    ).first()
    if in_use is not None:
        raise SshKeyInUseError(
            "This SSH key is used by an active GPU rental. Stop or terminate that "
            "rental before deleting the key."
        )

    db.delete(row)
    db.flush()
    return row


def ensure_aws_key_pair(db: Session, ssh_key: SshKey) -> str:
    """
    Lazily imports the key into AWS on first use and caches the resulting
    key pair name onto the SshKey row. Idempotent — safe to call every time
    a rental is created with this key.
    """
    if ssh_key.aws_key_pair_name:
        return ssh_key.aws_key_pair_name

    from app.compute import aws_provider

    unique_name = f"taskflow-{ssh_key.id}"
    aws_key_pair_name = aws_provider.import_ssh_key(ssh_key.public_key, unique_name)
    ssh_key.aws_key_pair_name = aws_key_pair_name
    db.flush()
    return aws_key_pair_name
