from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_platform_admin
from app.database import get_db
from app.models.billing import PlanCode
from app.services import admin as admin_service

router = APIRouter(
    prefix="/admin/organizations", tags=["admin"], dependencies=[Depends(require_platform_admin)]
)


class GrantCreditsRequest(BaseModel):
    amount_micros: int
    reason: str


class ChangePlanRequest(BaseModel):
    plan_code: PlanCode


def _parse_uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(400, "Invalid organization id")


@router.get("")
def list_organizations(db: Session = Depends(get_db)):
    return {"organizations": admin_service.list_organizations_summary(db)}


@router.get("/{organization_id}")
def get_organization(organization_id: str, db: Session = Depends(get_db)):
    detail = admin_service.get_organization_detail(db, _parse_uuid(organization_id))
    if detail is None:
        raise HTTPException(404, "Organization not found")
    return detail


@router.post("/{organization_id}/credits")
def grant_credits(
    organization_id: str,
    body: GrantCreditsRequest,
    ctx: RequestContext = Depends(require_platform_admin),
    db: Session = Depends(get_db),
):
    if not body.reason.strip():
        raise HTTPException(400, "reason is required — this is an audited financial action")

    try:
        new_balance = admin_service.grant_credits(
            db, _parse_uuid(organization_id), ctx.user_id, body.amount_micros, body.reason
        )
        db.commit()
    except admin_service.OrganizationNotFoundError:
        db.rollback()
        raise HTTPException(404, "Organization not found")
    return {"new_balance_micros": new_balance}


@router.post("/{organization_id}/plan")
def change_plan(organization_id: str, body: ChangePlanRequest, db: Session = Depends(get_db)):
    org_id = _parse_uuid(organization_id)
    try:
        admin_service.change_plan(db, org_id, body.plan_code)
        db.commit()
    except admin_service.OrganizationNotFoundError:
        db.rollback()
        raise HTTPException(404, "Organization not found")
    except admin_service.PlanNotFoundError:
        db.rollback()
        raise HTTPException(400, "Unknown plan_code")

    return admin_service.get_organization_detail(db, org_id)
