from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.api_key import ApiKey, ApiKeyStatus

KEY_PREFIX = "tf_live_"


def _hash_key(raw_key: str) -> str:
    settings = get_settings()
    # Peppered SHA-256 of a high-entropy token is standard practice for API
    # keys (unlike passwords, they're already maximum-entropy random strings,
    # so a slow KDF isn't required — but we still never store them raw).
    return hashlib.sha256((settings.taskflow_api_key_pepper + raw_key).encode()).hexdigest()


def generate_api_key(db: Session, organization_id: uuid.UUID, created_by_user_id: uuid.UUID, name: str) -> tuple[ApiKey, str]:
    raw_secret = secrets.token_urlsafe(32)
    raw_key = f"{KEY_PREFIX}{raw_secret}"
    row = ApiKey(
        organization_id=organization_id,
        created_by_user_id=created_by_user_id,
        name=name,
        prefix=raw_key[:12],
        key_hash=_hash_key(raw_key),
        status=ApiKeyStatus.ACTIVE,
    )
    db.add(row)
    db.flush()
    return row, raw_key  # raw_key is returned exactly once — caller must not persist it anywhere


def authenticate_api_key(db: Session, raw_key: str) -> ApiKey | None:
    if not raw_key.startswith(KEY_PREFIX):
        return None
    key_hash = _hash_key(raw_key)
    row = db.execute(
        select(ApiKey).where(ApiKey.key_hash == key_hash, ApiKey.status == ApiKeyStatus.ACTIVE)
    ).scalar_one_or_none()
    if row:
        row.last_used_at = datetime.now(timezone.utc)
        db.flush()
    return row


def revoke_api_key(db: Session, organization_id: uuid.UUID, api_key_id: uuid.UUID) -> bool:
    row = db.execute(
        select(ApiKey).where(ApiKey.id == api_key_id, ApiKey.organization_id == organization_id)
    ).scalar_one_or_none()
    if not row:
        return False
    row.status = ApiKeyStatus.REVOKED
    row.revoked_at = datetime.now(timezone.utc)
    db.flush()
    return True
