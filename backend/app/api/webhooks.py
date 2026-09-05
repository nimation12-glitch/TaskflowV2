from __future__ import annotations

import logging

import stripe
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.billing import stripe_service
from app.database import get_db

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
logger = logging.getLogger("taskflow.webhooks")

HANDLERS = {
    "checkout.session.completed": stripe_service.handle_checkout_completed,
    "customer.subscription.updated": stripe_service.handle_subscription_updated,
    "customer.subscription.created": stripe_service.handle_subscription_updated,
    "customer.subscription.deleted": stripe_service.handle_subscription_deleted,
    "invoice.paid": stripe_service.handle_invoice_paid,
    "invoice.payment_failed": stripe_service.handle_invoice_payment_failed,
}


@router.post("/stripe")
async def stripe_webhook(
    request: Request,
    stripe_signature: str | None = Header(default=None, alias="stripe-signature"),
    db: Session = Depends(get_db),
):
    if not stripe_signature:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing Stripe-Signature header")

    payload = await request.body()
    try:
        event = stripe_service.verify_and_parse_webhook(payload, stripe_signature)
    except stripe.SignatureVerificationError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid signature")
    except stripe_service.BillingNotConfiguredError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))

    event_id = event["id"]
    event_type = event["type"]

    if stripe_service.already_processed(db, event_id):
        # Idempotent: acknowledge success without repeating any side effect.
        return {"received": True, "duplicate": True}

    handler = HANDLERS.get(event_type)
    try:
        if handler:
            handler(db, event)
        stripe_service.mark_processed(db, event_id, event_type, dict(event))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Failed processing Stripe event %s (%s)", event_id, event_type)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Webhook processing failed")

    return {"received": True}
