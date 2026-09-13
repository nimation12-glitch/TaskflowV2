from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

from app.auth.internal import RequestContext, require_platform_admin
from app.database import get_db
from app.services import system as system_service

router = APIRouter(prefix="/system", tags=["system"])


class MaintenanceUpdateRequest(BaseModel):
    enabled: bool
    message: Optional[str] = None


def _serialize_public(row) -> dict:
    return {
        "maintenance_mode_enabled": row.maintenance_mode_enabled,
        "maintenance_message": row.maintenance_message,
    }


@router.get("/status")
def get_status(db: Session = Depends(get_db)):
    """
    Public, no authentication — this is what anonymous visitors and the
    frontend's global layout poll to decide whether to show the maintenance
    splash page. Must never require a login, or visitors locked out by
    maintenance mode couldn't even find out why.
    """
    row = system_service.get_or_create_settings(db)
    db.commit()
    return _serialize_public(row)


@router.post("/maintenance")
def set_maintenance(
    body: MaintenanceUpdateRequest,
    ctx: RequestContext = Depends(require_platform_admin),
    db: Session = Depends(get_db),
):
    row = system_service.set_maintenance_mode(
        db, enabled=body.enabled, message=body.message, updated_by_user_id=ctx.user_id
    )
    db.commit()
    return {
        **_serialize_public(row),
        "updated_by_user_id": str(row.updated_by_user_id) if row.updated_by_user_id else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
