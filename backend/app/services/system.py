from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.system import SystemSetting


def get_or_create_settings(db: Session) -> SystemSetting:
    """
    Exactly one row ever exists. Enforced here, not by a DB constraint —
    simplicity over cleverness for a table this small (see model docstring).
    """
    row = db.execute(select(SystemSetting).limit(1)).scalar_one_or_none()
    if row is None:
        row = SystemSetting(maintenance_mode_enabled=False, maintenance_message=None)
        db.add(row)
        db.flush()
    return row


def set_maintenance_mode(db: Session, *, enabled: bool, message: str | None, updated_by_user_id: uuid.UUID) -> SystemSetting:
    row = get_or_create_settings(db)
    row.maintenance_mode_enabled = enabled
    row.maintenance_message = message
    row.updated_by_user_id = updated_by_user_id
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    return row
