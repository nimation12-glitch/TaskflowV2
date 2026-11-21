from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.billing import stripe_service
from app.database import get_db
from app.models.billing import PlanCode
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
    ctx: RequestContext = Depends(require_context),
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
    ctx: RequestContext = Depends(require_context),
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


# --- In-app (embedded) Checkout -------------------------------------------
#
# The customer never leaves Taskflow: Stripe's secure card form is embedded
# inside our own branded /checkout page. That page needs three things this
# endpoint hands over — the client secret to mount the form, a summary to
# render next to it, and nothing else.
#
# A session id alone must not be a capability: every response is scoped to
# the caller's organization, and a foreign or malformed id reports 404 so we
# never confirm the existence of somebody else's checkout.


@router.get("/checkout/session")
def get_checkout_session(
    session_id: str,
    ctx: RequestContext = Depends(require_context),
):
    import stripe

    if not session_id.startswith("cs_"):
        raise HTTPException(400, "Invalid checkout session id")
    try:
        session = stripe.checkout.Session.retrieve(session_id)
    except stripe.InvalidRequestError:
        raise HTTPException(404, "Checkout session not found")

    if (session.get("metadata") or {}).get("organization_id") != str(ctx.organization_id):
        raise HTTPException(404, "Checkout session not found")

    try:
        line_items = stripe.checkout.Session.list_line_items(session_id, limit=10)
        raw_items = line_items.get("data", [])
    except stripe.StripeError:
        raw_items = []

    # Stripe quotes in pence; the whole product speaks micro-GBP (1 GBP =
    # 1_000_000 micros = 100 pence, so one penny is 10_000 micros).
    items = [
        {
            "name": item.get("description") or "Purchase",
            "amount_micros": int(item.get("amount_total") or 0) * 10_000,
        }
        for item in raw_items
    ]

    metadata = session.get("metadata") or {}
    purchase_type = metadata.get("purchase_type", "")
    if purchase_type == "subscription":
        title = f"Taskflow {metadata.get('plan', '')} plan".strip()
    elif purchase_type == "wallet_topup":
        title = "Top up your GPU wallet"
    elif purchase_type == "credit_purchase":
        title = "Buy credit"
    else:
        title = items[0]["name"] if items else "Taskflow purchase"

    return {
        "session_id": session_id,
        "client_secret": session.get("client_secret"),
        "mode": session.get("mode"),
        "status": session.get("status"),
        "payment_status": session.get("payment_status"),
        "currency": session.get("currency"),
        "total_micros": int(session.get("amount_total") or 0) * 10_000,
        "title": title,
        "items": items,
        "purchase_type": purchase_type,
        "plan": metadata.get("plan"),
    }


@router.post("/portal")
def billing_portal(
    ctx: RequestContext = Depends(require_context),
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
# update or delete endpoint anywhere. Any organization member can read
# their own organization's ledger — it is their own workspace's money.


@router.get("/statement")
def get_statement(
    ctx: RequestContext = Depends(require_context),
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
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    """Snapshot history (metadata only), newest first."""
    return {"statements": statement_service.list_statements(db, ctx.organization_id)}


@router.get("/statement/{statement_id}")
def statement_snapshot(
    statement_id: str,
    ctx: RequestContext = Depends(require_context),
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
