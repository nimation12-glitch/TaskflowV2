"""
Platform-admin org-management operations. Every function here can act on
ANY organization, bypassing the tenant-scoping the rest of the app enforces
everywhere else — that's the entire point of this module. Every route that
calls into it MUST be gated by require_platform_admin, never require_context
alone. See app/api/admin.py.
"""
from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.billing import CreditTransaction, CreditTransactionType, Plan, PlanCode, Subscription, SubscriptionStatus
from app.models.compute import GpuInstance, GpuInstanceStatus
from app.models.org import Membership, Organization
from app.services import credits as credits_service

_ACTIVE_RENTAL_STATUSES = (GpuInstanceStatus.PROVISIONING, GpuInstanceStatus.RUNNING, GpuInstanceStatus.STOPPED)


class OrganizationNotFoundError(Exception):
    pass


class PlanNotFoundError(Exception):
    pass


def _plan_for_org(db: Session, organization_id: uuid.UUID) -> Plan | None:
    """
    Mirrors app/services/gpu_rentals.py::get_plan_for_org — every org is
    bootstrapped with a FREE subscription (see services/org.py), so this
    fallback only guards against a genuinely missing row, and is
    deliberately the most restrictive plan, never the most permissive.
    """
    sub = db.execute(select(Subscription).where(Subscription.organization_id == organization_id)).scalar_one_or_none()
    if sub:
        plan = db.get(Plan, sub.plan_id)
        if plan:
            return plan
    return db.execute(select(Plan).where(Plan.code == PlanCode.FREE)).scalar_one_or_none()


def _active_rental_count(db: Session, organization_id: uuid.UUID) -> int:
    return db.execute(
        select(func.count()).select_from(GpuInstance).where(
            GpuInstance.organization_id == organization_id, GpuInstance.status.in_(_ACTIVE_RENTAL_STATUSES)
        )
    ).scalar_one()


def _summary(db: Session, org: Organization) -> dict:
    plan = _plan_for_org(db, org.id)
    account = credits_service.get_or_create_account(db, org.id)
    member_count = db.execute(
        select(func.count()).select_from(Membership).where(Membership.organization_id == org.id)
    ).scalar_one()
    return {
        "id": str(org.id),
        "name": org.name,
        "plan_code": plan.code.value if plan else None,
        "wallet_balance_micros": account.balance_micros,
        "member_count": member_count,
        "active_gpu_rental_count": _active_rental_count(db, org.id),
        "created_at": org.created_at.isoformat(),
    }


def list_organizations_summary(db: Session) -> list[dict]:
    orgs = list(db.execute(select(Organization).order_by(Organization.created_at.desc())).scalars())
    return [_summary(db, org) for org in orgs]


def get_organization_detail(db: Session, organization_id: uuid.UUID) -> dict | None:
    org = db.get(Organization, organization_id)
    if org is None:
        return None

    members = list(db.execute(select(Membership).where(Membership.organization_id == org.id)).scalars())
    recent_txns = list(
        db.execute(
            select(CreditTransaction)
            .where(CreditTransaction.organization_id == org.id)
            .order_by(CreditTransaction.created_at.desc())
            .limit(20)
        ).scalars()
    )

    return {
        **_summary(db, org),
        "members": [{"user_id": str(m.user_id), "role": m.role.value} for m in members],
        "recent_credit_transactions": [
            {
                "type": t.type.value,
                "amount_micros": t.amount_micros,
                "description": t.description,
                "created_at": t.created_at.isoformat(),
            }
            for t in recent_txns
        ],
    }


def grant_credits(db: Session, organization_id: uuid.UUID, admin_user_id: uuid.UUID, amount_micros: int, reason: str) -> int:
    """
    Always an audited ledger entry (CreditTransactionType.ADJUSTMENT), never
    a raw balance edit. allow_overdraft=True deliberately — an admin
    correction (including a deduction) should never be blocked by the
    normal balance floor that protects customer-initiated debits.
    Returns the new balance.
    """
    org = db.get(Organization, organization_id)
    if org is None:
        raise OrganizationNotFoundError()

    txn = credits_service.record_transaction(
        db,
        organization_id=organization_id,
        type=CreditTransactionType.ADJUSTMENT,
        amount_micros=amount_micros,
        description=f"Admin adjustment by {admin_user_id}: {reason}",
        allow_overdraft=True,
    )
    return txn.balance_after_micros


def change_plan(db: Session, organization_id: uuid.UUID, plan_code: PlanCode) -> None:
    """Force-changes an org's plan without Stripe — for support/comped-account use, not a billing flow."""
    org = db.get(Organization, organization_id)
    if org is None:
        raise OrganizationNotFoundError()

    plan = db.execute(select(Plan).where(Plan.code == plan_code)).scalar_one_or_none()
    if plan is None:
        raise PlanNotFoundError()

    sub = db.execute(select(Subscription).where(Subscription.organization_id == organization_id)).scalar_one_or_none()
    if sub is None:
        sub = Subscription(organization_id=organization_id, plan_id=plan.id, status=SubscriptionStatus.ACTIVE)
        db.add(sub)
    else:
        sub.plan_id = plan.id
    db.flush()
