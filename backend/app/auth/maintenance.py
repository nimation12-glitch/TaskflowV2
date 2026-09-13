"""
Maintenance-mode enforcement. Two separate checks because the routes they
guard use two different auth mechanisms:

  - /v1/* (the AI gateway) is authenticated by API key, not the admin JWT —
    there is no admin identity available on that path at all. Per product
    decision, this blocks unconditionally for everyone during maintenance,
    with no admin exception.
  - /compute/* (GPU rentals, wallet, catalog) is authenticated by the
    session JWT via require_context, so a verified platform admin can pass
    through and keep testing while maintenance is active.

Deliberately NOT applied to /health, /system/status, /webhooks/stripe, or
anything under /internal/* (including the GPU safety sweep) — those must
always be reachable regardless of maintenance mode. This is enforced simply
by never attaching either dependency to those routers, not by an exception
list inside the checks themselves — see app/main.py for what's wired where.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.database import get_db
from app.services import system as system_service


def block_if_maintenance_unconditional(db: Session = Depends(get_db)) -> None:
    """For /v1/* — blocks every caller during maintenance. No exceptions: there's no admin identity on this auth path to bypass with."""
    row = system_service.get_or_create_settings(db)
    if row.maintenance_mode_enabled:
        raise HTTPException(status_code=503, detail=row.maintenance_message or "TaskFlow is currently in maintenance mode")


def block_if_maintenance_unless_admin(
    ctx: RequestContext = Depends(require_context), db: Session = Depends(get_db)
) -> RequestContext:
    """For /compute/* — blocks non-admins during maintenance; a verified platform admin passes through normally."""
    if ctx.is_platform_admin:
        return ctx
    row = system_service.get_or_create_settings(db)
    if row.maintenance_mode_enabled:
        raise HTTPException(status_code=503, detail=row.maintenance_message or "TaskFlow is currently in maintenance mode")
    return ctx
