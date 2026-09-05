from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_role
from app.billing import stripe_service
from app.database import get_db
from app.models.billing import PlanCode
from app.models.org import Role

router = APIRouter(prefix="/billing", tags=["billing"])


class CheckoutSubscriptionRequest(BaseModel):
    plan: PlanCode
    email: EmailStr


class CheckoutCreditsRequest(BaseModel):
    amount_micros: int
    email: EmailStr


@router.post("/checkout/subscription")
def checkout_subscription(
    body: CheckoutSubscriptionRequest,
    ctx: RequestContext = Depends(require_role(Role.OWNER)),
    db: Session = Depends(get_db),
):
    from app.models.org import Organization

    org = db.get(Organization, ctx.organization_id)
    if not org:
        raise HTTPException(404, "Organization not found")
    if body.plan == PlanCode.FREE:
        raise HTTPException(400, "Cannot checkout the Free plan")
    try:
        url = stripe_service.create_subscription_checkout_session(db, org, body.email, body.plan)
        db.commit()
    except stripe_service.BillingNotConfiguredError as exc:
        db.rollback()
        raise HTTPException(503, str(exc))
    return {"checkout_url": url}


@router.post("/checkout/credits")
def checkout_credits(
    body: CheckoutCreditsRequest,
    ctx: RequestContext = Depends(require_role(Role.OWNER)),
    db: Session = Depends(get_db),
):
    from app.models.org import Organization

    org = db.get(Organization, ctx.organization_id)
    if not org:
        raise HTTPException(404, "Organization not found")
    try:
        url = stripe_service.create_credit_purchase_checkout_session(db, org, body.email, body.amount_micros)
        db.commit()
    except stripe_service.BillingNotConfiguredError as exc:
        db.rollback()
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"checkout_url": url}


@router.post("/portal")
def billing_portal(
    ctx: RequestContext = Depends(require_role(Role.OWNER)),
    db: Session = Depends(get_db),
):
    from app.models.org import Organization

    org = db.get(Organization, ctx.organization_id)
    if not org:
        raise HTTPException(404, "Organization not found")
    try:
        url = stripe_service.create_billing_portal_session(db, org)
    except stripe_service.BillingNotConfiguredError as exc:
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"portal_url": url}
