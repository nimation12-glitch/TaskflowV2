from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.auth.service import require_gpu_sweep_secret, require_service_secret
from app.database import get_db
from app.services import gpu_billing
from app.services import org as org_service

router = APIRouter(prefix="/internal", tags=["internal"], dependencies=[Depends(require_service_secret)])

# Deliberately a separate router with its own secret (GPU_SWEEP_SERVICE_SECRET,
# not BACKEND_SERVICE_SECRET) — see app/auth/service.py::require_gpu_sweep_secret.
# Must be called every 2-5 minutes by an external cron; this is the safety
# net that catches rentals nobody is actively watching on a dashboard.
gpu_sweep_router = APIRouter(prefix="/internal/gpu", tags=["internal"], dependencies=[Depends(require_gpu_sweep_secret)])


@gpu_sweep_router.post("/sweep")
def sweep_gpu_instances(db: Session = Depends(get_db)):
    result = gpu_billing.run_safety_sweep(db)
    db.commit()
    return {
        "checked": result.checked,
        "billed": result.billed,
        "auto_stopped": result.auto_stopped,
        "auto_terminated": result.auto_terminated,
        "marked_failed": result.marked_failed,
    }


class BootstrapRequest(BaseModel):
    user_id: uuid.UUID
    display_name: str | None = None
    email: EmailStr


@router.post("/bootstrap-organization")
def bootstrap_organization(body: BootstrapRequest, db: Session = Depends(get_db)):
    org = org_service.bootstrap_organization_for_new_user(db, body.user_id, body.display_name, body.email)
    return {"organization_id": str(org.id), "organization_name": org.name, "organization_slug": org.slug}


@router.get("/memberships/{user_id}")
def memberships_for_user(user_id: uuid.UUID, db: Session = Depends(get_db)):
    """
    Used by NextAuth's JWT callback on every sign-in to embed the user's
    organization memberships (id + role) into their session token.
    """
    rows = org_service.list_memberships_for_user(db, user_id)
    return {
        "memberships": [
            {"organization_id": str(m.organization_id), "role": m.role.value} for m in rows
        ]
    }
