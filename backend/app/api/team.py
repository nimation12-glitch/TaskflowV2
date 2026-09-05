from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context, require_role
from app.auth.service import require_service_secret
from app.database import get_db
from app.models.org import Invitation, InvitationStatus, Membership, Role
from app.services import invitations as invitation_service

router = APIRouter(prefix="/team", tags=["team"])


@router.get("/members")
def list_members(ctx: RequestContext = Depends(require_context), db: Session = Depends(get_db)):
    rows = db.execute(select(Membership).where(Membership.organization_id == ctx.organization_id)).scalars()
    return [{"user_id": str(m.user_id), "role": m.role.value, "joined_at": m.created_at.isoformat()} for m in rows]


@router.get("/invitations")
def list_invitations(ctx: RequestContext = Depends(require_context), db: Session = Depends(get_db)):
    rows = db.execute(
        select(Invitation).where(
            Invitation.organization_id == ctx.organization_id, Invitation.status == InvitationStatus.PENDING
        )
    ).scalars()
    return [
        {
            "id": str(i.id),
            "invited_email": i.invited_email,
            "role": i.role.value,
            "expires_at": i.expires_at.isoformat(),
        }
        for i in rows
    ]


class InviteRequest(BaseModel):
    email: EmailStr
    role: Role = Role.MEMBER


@router.post("/invitations")
def invite_member(
    body: InviteRequest,
    ctx: RequestContext = Depends(require_role(Role.OWNER, Role.ADMIN)),
    db: Session = Depends(get_db),
):
    try:
        invitation, raw_token = invitation_service.create_invitation(
            db, ctx.organization_id, ctx.user_id, body.email, body.role
        )
        db.commit()
    except invitation_service.SeatLimitExceededError as exc:
        db.rollback()
        raise HTTPException(402, str(exc))
    # The frontend's server-side email service sends the invite link containing
    # raw_token — it is never persisted anywhere in plaintext after this response.
    return {"id": str(invitation.id), "invited_email": invitation.invited_email, "token": raw_token}


@router.delete("/members/{user_id}")
def remove_member(
    user_id: uuid.UUID,
    ctx: RequestContext = Depends(require_role(Role.OWNER, Role.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.execute(
        select(Membership).where(Membership.organization_id == ctx.organization_id, Membership.user_id == user_id)
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Member not found")
    if row.role == Role.OWNER:
        raise HTTPException(400, "Cannot remove the organization owner")
    db.delete(row)
    db.commit()
    return {"removed": True}


class AcceptInvitationRequest(BaseModel):
    token: str
    user_id: uuid.UUID
    email: EmailStr


@router.post("/invitations/accept", dependencies=[Depends(require_service_secret)])
def accept_invitation(body: AcceptInvitationRequest, db: Session = Depends(get_db)):
    """Called server-side by Next.js after NextAuth confirms the accepting user's identity."""
    try:
        membership = invitation_service.accept_invitation(db, body.token, body.user_id, body.email)
        db.commit()
    except invitation_service.SeatLimitExceededError as exc:
        db.rollback()
        raise HTTPException(402, str(exc))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(400, str(exc))
    return {"organization_id": str(membership.organization_id), "role": membership.role.value}
