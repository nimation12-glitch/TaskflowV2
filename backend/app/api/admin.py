from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_platform_admin
from app.database import get_db
from app.models.billing import PlanCode
from app.models.org import Membership, Organization
from app.services import admin as admin_service

router = APIRouter(
    prefix="/admin/organizations", tags=["admin"], dependencies=[Depends(require_platform_admin)]
)

# Separate router because the shared prefix already has a /{organization_id}
# catch-all — /admin/users would be swallowed by it if it lived on `router`.
users_router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_platform_admin)])


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


@users_router.get("/users")
def list_users(db: Session = Depends(get_db)):
    """
    Directory for the admin panel's Users tab: every identity-DB user id that
    holds a membership, with the organizations they belong to and their role
    in each. Identity data itself (emails, names, ban state, site roles)
    lives in the Next.js/Prisma identity DB and is joined there — this
    backend has no users table of its own.
    """
    rows = db.execute(
        select(
            Membership.user_id,
            Membership.role,
            Organization.id.label("organization_id"),
            Organization.name.label("organization_name"),
        )
        .join(Organization, Membership.organization_id == Organization.id)
        .order_by(Organization.created_at, Membership.created_at)
    ).all()

    grouped: dict[str, dict] = {}
    for user_id, role, organization_id, organization_name in rows:
        entry = grouped.setdefault(str(user_id), {"user_id": str(user_id), "organizations": []})
        entry["organizations"].append(
            {
                "id": str(organization_id),
                "name": organization_name,
                "role": role.value,
            }
        )
    return {"users": list(grouped.values())}
