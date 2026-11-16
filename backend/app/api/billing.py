from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_role
from app.billing import stripe_service
from app.database import get_db
from app.models.billing import PlanCode
from app.models.org import Role
from app.services import statement as statement_service

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


# --- Account statements ---------------------------------------------------
#
# Read-only JSON documents assembled from the append-only billing ledger.
# Generation appends a new immutable snapshot; there is deliberately no
# update or delete endpoint anywhere. OWNER-only: statements contain the
# full financial ledger of the organization.


@router.get("/statement")
def get_statement(
    ctx: RequestContext = Depends(require_role(Role.OWNER)),
    db: Session = Depends(get_db),
):
    """Generate a fresh statement and store it as a new immutable snapshot."""
    try:
        result = statement_service.generate_statement(
            db, ctx.organization_id, ctx.user_id
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    db.commit()
    return result


@router.get("/statement/history")
def statement_history(
    ctx: RequestContext = Depends(require_role(Role.OWNER)),
    db: Session = Depends(get_db),
):
    """Snapshot history (metadata only), newest first."""
    return {"statements": statement_service.list_statements(db, ctx.organization_id)}


@router.get("/statement/{statement_id}")
def statement_snapshot(
    statement_id: str,
    ctx: RequestContext = Depends(require_role(Role.OWNER)),
    db: Session = Depends(get_db),
):
    """Fetch one stored snapshot after verifying its integrity hash."""
    import uuid as uuid_mod

    try:
        statement_uuid = uuid_mod.UUID(statement_id)
    except ValueError:
        raise HTTPException(400, "Invalid statement id")
    try:
        row = statement_service.get_statement(db, ctx.organization_id, statement_uuid)
    except LookupError as exc:
        raise HTTPException(404, str(exc))
    except statement_service.StatementTamperedError as exc:
        raise HTTPException(500, str(exc))
    return {
        "statement": row.content,
        "statement_id": str(row.id),
        "content_sha256": row.content_sha256,
        "generated_at": row.generated_at.isoformat(),
        "format_version": row.format_version,
    }
