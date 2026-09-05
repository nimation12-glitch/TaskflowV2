from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.database import get_db
from app.models.billing import Plan, Subscription
from app.models.catalog import AiModel, Provider

router = APIRouter(prefix="/models", tags=["models"])


@router.get("")
def list_models(ctx: RequestContext = Depends(require_context), db: Session = Depends(get_db)):
    sub = db.execute(select(Subscription).where(Subscription.organization_id == ctx.organization_id)).scalar_one_or_none()
    plan = db.get(Plan, sub.plan_id) if sub else None

    models = db.execute(select(AiModel)).scalars()
    result = []
    for m in models:
        provider = db.get(Provider, m.provider_id)
        entitled_plans = {e.plan_code.value for e in m.entitlements}
        accessible = bool(plan and plan.code.value in entitled_plans)
        result.append(
            {
                "slug": m.slug,
                "display_name": m.display_name,
                "provider": provider.display_name if provider else None,
                "hosting_mode": m.hosting_mode.value,
                "status": m.status.value,
                "capabilities": m.capabilities,
                "context_window": m.context_window,
                "entitled_plans": sorted(entitled_plans),
                "accessible_on_current_plan": accessible,
            }
        )
    return result
