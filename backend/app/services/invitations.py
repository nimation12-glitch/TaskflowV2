from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.billing import Plan, Subscription
from app.models.org import Invitation, InvitationStatus, Membership, Role

INVITATION_TTL = timedelta(days=7)


class SeatLimitExceededError(Exception):
    pass


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _current_seat_count(db: Session, organization_id: uuid.UUID) -> int:
    members = db.execute(
        select(func.count()).select_from(Membership).where(Membership.organization_id == organization_id)
    ).scalar_one()
    pending_invites = db.execute(
        select(func.count())
        .select_from(Invitation)
        .where(Invitation.organization_id == organization_id, Invitation.status == InvitationStatus.PENDING)
    ).scalar_one()
    return members + pending_invites


def _max_seats(db: Session, organization_id: uuid.UUID) -> int:
    sub = db.execute(select(Subscription).where(Subscription.organization_id == organization_id)).scalar_one_or_none()
    if not sub:
        return 3
    plan = db.get(Plan, sub.plan_id)
    return plan.max_members if plan else 3


def create_invitation(
    db: Session, organization_id: uuid.UUID, invited_by_user_id: uuid.UUID, invited_email: str, role: Role
) -> tuple[Invitation, str]:
    if _current_seat_count(db, organization_id) >= _max_seats(db, organization_id):
        raise SeatLimitExceededError("Organization has reached its member seat limit for the current plan")

    raw_token = secrets.token_urlsafe(32)
    invitation = Invitation(
        organization_id=organization_id,
        invited_email=invited_email.lower(),
        invited_by_user_id=invited_by_user_id,
        role=role,
        token_hash=_hash_token(raw_token),
        status=InvitationStatus.PENDING,
        expires_at=datetime.now(timezone.utc) + INVITATION_TTL,
    )
    db.add(invitation)
    db.flush()
    return invitation, raw_token


def _as_aware_utc(dt: datetime) -> datetime:
    """Postgres (DateTime(timezone=True)) always round-trips tz-aware datetimes,
    but SQLite (used in tests) silently drops tzinfo — normalize defensively
    so this comparison is correct on both backends."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def accept_invitation(db: Session, raw_token: str, accepting_user_id: uuid.UUID, accepting_email: str) -> Membership:
    token_hash = _hash_token(raw_token)
    invitation = db.execute(select(Invitation).where(Invitation.token_hash == token_hash)).scalar_one_or_none()
    if not invitation or invitation.status != InvitationStatus.PENDING:
        raise ValueError("Invalid or already-used invitation")
    if _as_aware_utc(invitation.expires_at) < datetime.now(timezone.utc):
        invitation.status = InvitationStatus.EXPIRED
        db.flush()
        raise ValueError("Invitation has expired")
    if invitation.invited_email != accepting_email.lower():
        raise ValueError("This invitation was issued to a different email address")

    existing = db.execute(
        select(Membership).where(
            Membership.organization_id == invitation.organization_id, Membership.user_id == accepting_user_id
        )
    ).scalar_one_or_none()
    if existing:
        invitation.status = InvitationStatus.ACCEPTED
        invitation.accepted_at = datetime.now(timezone.utc)
        db.flush()
        return existing

    if _current_seat_count(db, invitation.organization_id) > _max_seats(db, invitation.organization_id):
        raise SeatLimitExceededError("Organization is at capacity")

    membership = Membership(
        organization_id=invitation.organization_id,
        user_id=accepting_user_id,
        role=invitation.role,
        invited_by_user_id=invitation.invited_by_user_id,
    )
    db.add(membership)
    invitation.status = InvitationStatus.ACCEPTED
    invitation.accepted_at = datetime.now(timezone.utc)
    db.flush()
    return membership
