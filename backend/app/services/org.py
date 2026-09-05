from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.billing import CreditAccount, Plan, PlanCode, Subscription, SubscriptionStatus
from app.models.org import Membership, Organization, Role


def _slugify(name: str, suffix: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "workspace"
    return f"{base}-{suffix}"[:200]


def bootstrap_organization_for_new_user(db: Session, user_id: uuid.UUID, display_name: str | None, email: str) -> Organization:
    """
    Called exactly once, from NextAuth's createUser event, the first time a
    person signs up (any method — email/password, Google, Microsoft, GitHub).
    Idempotent: if the user already owns an organization, returns it instead
    of creating a duplicate (guards against retried webhook-style calls).
    """
    existing = db.execute(
        select(Membership).where(Membership.user_id == user_id, Membership.role == Role.OWNER)
    ).scalar_one_or_none()
    if existing:
        return db.get(Organization, existing.organization_id)

    name = f"{display_name}'s Workspace" if display_name else "My Workspace"
    slug = _slugify(display_name or email.split("@")[0], uuid.uuid4().hex[:8])

    org = Organization(name=name, slug=slug)
    db.add(org)
    db.flush()

    db.add(Membership(organization_id=org.id, user_id=user_id, role=Role.OWNER))

    free_plan = db.execute(select(Plan).where(Plan.code == PlanCode.FREE)).scalar_one()
    db.add(
        Subscription(
            organization_id=org.id,
            plan_id=free_plan.id,
            status=SubscriptionStatus.ACTIVE,
        )
    )
    db.add(CreditAccount(organization_id=org.id, balance_micros=free_plan.monthly_credit_micros))

    db.flush()
    db.commit()
    return org


def get_membership(db: Session, user_id: uuid.UUID, organization_id: uuid.UUID) -> Membership | None:
    return db.execute(
        select(Membership).where(Membership.user_id == user_id, Membership.organization_id == organization_id)
    ).scalar_one_or_none()


def list_memberships_for_user(db: Session, user_id: uuid.UUID) -> list[Membership]:
    return list(db.execute(select(Membership).where(Membership.user_id == user_id)).scalars())
