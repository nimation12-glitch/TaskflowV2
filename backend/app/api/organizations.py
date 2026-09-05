from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.database import get_db
from app.models.billing import CreditAccount, Plan, Subscription
from app.models.org import Organization
from app.services.credits import get_or_create_account

router = APIRouter(prefix="/organizations", tags=["organizations"])


@router.get("/me")
def get_current_organization(ctx: RequestContext = Depends(require_context), db: Session = Depends(get_db)):
    org = db.get(Organization, ctx.organization_id)
    if not org:
        raise HTTPException(404, "Organization not found")

    sub = db.execute(select(Subscription).where(Subscription.organization_id == org.id)).scalar_one_or_none()
    plan = db.get(Plan, sub.plan_id) if sub else None
    account = get_or_create_account(db, org.id)
    db.commit()

    return {
        "id": str(org.id),
        "name": org.name,
        "slug": org.slug,
        "role": ctx.role.value,
        "subscription": {
            "status": sub.status.value if sub else None,
            "current_period_end": sub.current_period_end.isoformat() if sub and sub.current_period_end else None,
            "cancel_at_period_end": sub.cancel_at_period_end if sub else False,
        }
        if sub
        else None,
        "plan": {
            "code": plan.code.value,
            "display_name": plan.display_name,
            "monthly_price_micros": plan.monthly_price_micros,
            "monthly_credit_micros": plan.monthly_credit_micros,
            "rate_limit_rpm": plan.rate_limit_rpm,
            "max_members": plan.max_members,
            "allows_gpu_rental": plan.allows_gpu_rental,
        }
        if plan
        else None,
        "credit_balance_micros": account.balance_micros,
    }
