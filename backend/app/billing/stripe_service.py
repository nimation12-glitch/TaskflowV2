"""
Real Stripe billing. No simulated fallback exists anywhere in this module —
if STRIPE_SECRET_KEY is not set, every function here raises rather than
pretending to succeed.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import stripe
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.billing import (
    CreditTransactionType,
    Invoice,
    Plan,
    PlanCode,
    StripeCustomer,
    StripeEvent,
    Subscription,
    SubscriptionStatus,
)
from app.models.org import Organization
from app.services import credits as credits_service

settings = get_settings()


class BillingNotConfiguredError(Exception):
    pass


def _client() -> stripe:
    if not settings.stripe_secret_key:
        raise BillingNotConfiguredError(
            "STRIPE_SECRET_KEY is not set. TaskFlow does not simulate billing — "
            "configure a real Stripe account to enable this endpoint."
        )
    stripe.api_key = settings.stripe_secret_key
    return stripe


CREDIT_PACKAGE_PRICE_IDS = {
    10_000_000: "stripe_price_credit_10",   # keys are micro-GBP amounts; values are Settings attr names
    25_000_000: "stripe_price_credit_25",
    50_000_000: "stripe_price_credit_50",
    100_000_000: "stripe_price_credit_100",
}


def get_or_create_stripe_customer(db: Session, org: Organization, email: str) -> str:
    client = _client()
    existing = db.execute(
        select(StripeCustomer).where(StripeCustomer.organization_id == org.id)
    ).scalar_one_or_none()
    if existing:
        return existing.stripe_customer_id

    customer = client.Customer.create(
        email=email,
        name=org.name,
        metadata={"organization_id": str(org.id)},
    )
    row = StripeCustomer(organization_id=org.id, stripe_customer_id=customer["id"])
    db.add(row)
    db.flush()
    return customer["id"]


def create_subscription_checkout_session(
    db: Session, org: Organization, email: str, plan_code: PlanCode
) -> str:
    """Returns a Stripe Checkout URL for a Pro/Max subscription."""
    client = _client()
    price_id = settings.stripe_price_pro if plan_code == PlanCode.PRO else settings.stripe_price_max
    if not price_id:
        raise BillingNotConfiguredError(f"No Stripe price configured for plan {plan_code}")

    customer_id = get_or_create_stripe_customer(db, org, email)

    session = client.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=f"{settings.app_base_url}/dashboard/billing?checkout=success",
        cancel_url=f"{settings.app_base_url}/dashboard/billing?checkout=cancelled",
        metadata={"organization_id": str(org.id), "plan": plan_code.value, "purchase_type": "subscription"},
        subscription_data={"metadata": {"organization_id": str(org.id), "plan": plan_code.value}},
    )
    return session["url"]


def create_credit_purchase_checkout_session(
    db: Session, org: Organization, email: str, amount_micros: int
) -> str:
    client = _client()
    attr_name = CREDIT_PACKAGE_PRICE_IDS.get(amount_micros)
    if not attr_name:
        raise ValueError("Unsupported credit package amount")
    price_id = getattr(settings, attr_name)
    if not price_id:
        raise BillingNotConfiguredError(f"No Stripe price configured for credit package {amount_micros}")

    customer_id = get_or_create_stripe_customer(db, org, email)

    session = client.checkout.Session.create(
        mode="payment",
        customer=customer_id,
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=f"{settings.app_base_url}/dashboard/billing?checkout=success",
        cancel_url=f"{settings.app_base_url}/dashboard/billing?checkout=cancelled",
        metadata={
            "organization_id": str(org.id),
            "purchase_type": "credit_purchase",
            "amount_micros": str(amount_micros),
        },
    )
    return session["url"]


def create_billing_portal_session(db: Session, org: Organization) -> str:
    client = _client()
    existing = db.execute(
        select(StripeCustomer).where(StripeCustomer.organization_id == org.id)
    ).scalar_one_or_none()
    if not existing:
        raise ValueError("Organization has no Stripe customer yet")
    portal = client.billing_portal.Session.create(
        customer=existing.stripe_customer_id,
        return_url=f"{settings.app_base_url}/dashboard/billing",
    )
    return portal["url"]


def verify_and_parse_webhook(payload: bytes, sig_header: str) -> "stripe.Event":
    if not settings.stripe_webhook_secret:
        raise BillingNotConfiguredError("STRIPE_WEBHOOK_SECRET is not set")
    # Raises stripe.error.SignatureVerificationError on invalid/missing signature —
    # callers must reject the request (see app/api/webhooks.py). No bypass path exists.
    return stripe.Webhook.construct_event(payload, sig_header, settings.stripe_webhook_secret)


def already_processed(db: Session, stripe_event_id: str) -> bool:
    return db.execute(
        select(StripeEvent).where(StripeEvent.stripe_event_id == stripe_event_id)
    ).scalar_one_or_none() is not None


def mark_processed(db: Session, stripe_event_id: str, event_type: str, payload: dict) -> None:
    db.add(
        StripeEvent(
            stripe_event_id=stripe_event_id,
            event_type=event_type,
            processed_at=datetime.now(timezone.utc),
            payload=payload,
        )
    )
    db.flush()


def handle_checkout_completed(db: Session, event: dict) -> None:
    session = event["data"]["object"]
    metadata = session.get("metadata") or {}
    purchase_type = metadata.get("purchase_type")
    org_id_raw = metadata.get("organization_id")
    if not org_id_raw:
        return  # not a TaskFlow-initiated checkout; ignore safely
    org_id = uuid.UUID(org_id_raw)

    if purchase_type == "credit_purchase":
        amount_micros = int(metadata.get("amount_micros", "0"))
        if amount_micros <= 0:
            return
        credits_service.record_transaction(
            db,
            organization_id=org_id,
            type=CreditTransactionType.PURCHASE,
            amount_micros=amount_micros,
            description=f"Stripe credit purchase (£{amount_micros / 1_000_000:.2f})",
            stripe_event_id=event["id"],
            stripe_payment_intent_id=session.get("payment_intent"),
            stripe_checkout_session_id=session.get("id"),
        )
    elif purchase_type == "subscription":
        # Subscription entitlement/credit grant is driven by
        # customer.subscription.updated + invoice.paid, handled below,
        # since those carry the authoritative period dates.
        pass


def _sync_subscription_row(db: Session, org_id: uuid.UUID, stripe_sub: dict) -> Subscription:
    plan_code_raw = (stripe_sub.get("metadata") or {}).get("plan")
    status_map = {
        "active": SubscriptionStatus.ACTIVE,
        "trialing": SubscriptionStatus.TRIALING,
        "past_due": SubscriptionStatus.PAST_DUE,
        "canceled": SubscriptionStatus.CANCELED,
        "incomplete": SubscriptionStatus.INCOMPLETE,
        "incomplete_expired": SubscriptionStatus.CANCELED,
        "unpaid": SubscriptionStatus.PAYMENT_FAILED,
    }
    new_status = status_map.get(stripe_sub.get("status", ""), SubscriptionStatus.INCOMPLETE)

    row = db.execute(select(Subscription).where(Subscription.organization_id == org_id)).scalar_one_or_none()
    if row is None:
        plan_code = PlanCode(plan_code_raw) if plan_code_raw else PlanCode.FREE
        plan = db.execute(select(Plan).where(Plan.code == plan_code)).scalar_one()
        row = Subscription(organization_id=org_id, plan_id=plan.id, status=new_status)
        db.add(row)
    elif plan_code_raw:
        plan = db.execute(select(Plan).where(Plan.code == PlanCode(plan_code_raw))).scalar_one()
        row.plan_id = plan.id

    row.status = new_status
    row.stripe_subscription_id = stripe_sub.get("id")
    row.cancel_at_period_end = bool(stripe_sub.get("cancel_at_period_end"))
    period = stripe_sub.get("current_period_start"), stripe_sub.get("current_period_end")
    if period[0]:
        row.current_period_start = datetime.fromtimestamp(period[0], tz=timezone.utc)
    if period[1]:
        row.current_period_end = datetime.fromtimestamp(period[1], tz=timezone.utc)
    db.flush()
    return row


def handle_subscription_updated(db: Session, event: dict) -> None:
    stripe_sub = event["data"]["object"]
    org_id_raw = (stripe_sub.get("metadata") or {}).get("organization_id")
    if not org_id_raw:
        return
    _sync_subscription_row(db, uuid.UUID(org_id_raw), stripe_sub)


def handle_subscription_deleted(db: Session, event: dict) -> None:
    stripe_sub = event["data"]["object"]
    org_id_raw = (stripe_sub.get("metadata") or {}).get("organization_id")
    if not org_id_raw:
        return
    org_id = uuid.UUID(org_id_raw)
    row = db.execute(select(Subscription).where(Subscription.organization_id == org_id)).scalar_one_or_none()
    if row:
        row.status = SubscriptionStatus.CANCELED
        free_plan = db.execute(select(Plan).where(Plan.code == PlanCode.FREE)).scalar_one()
        row.plan_id = free_plan.id
        db.flush()


def handle_invoice_paid(db: Session, event: dict) -> None:
    """
    This is the ONLY place monthly subscription credits are granted. Guarded by
    last_credit_grant_period_start so a webhook retry (same or replayed event)
    can never double-grant — combined with the StripeEvent idempotency table,
    this is defense in depth.
    """
    invoice = event["data"]["object"]
    stripe_sub_id = invoice.get("subscription")
    if not stripe_sub_id:
        return  # one-off payment (credit purchase), not a subscription invoice

    row = db.execute(
        select(Subscription).where(Subscription.stripe_subscription_id == stripe_sub_id)
    ).scalar_one_or_none()
    if row is None:
        return

    period_start_ts = invoice.get("period_start") or (
        invoice.get("lines", {}).get("data", [{}])[0].get("period", {}).get("start")
    )
    period_start = datetime.fromtimestamp(period_start_ts, tz=timezone.utc) if period_start_ts else None

    if period_start and row.last_credit_grant_period_start == period_start:
        return  # already granted for this billing period

    plan = db.get(Plan, row.plan_id)
    credits_service.record_transaction(
        db,
        organization_id=row.organization_id,
        type=CreditTransactionType.MONTHLY_GRANT,
        amount_micros=plan.monthly_credit_micros,
        description=f"Monthly {plan.display_name} credit allowance",
        stripe_event_id=event["id"],
    )
    row.status = SubscriptionStatus.ACTIVE
    if period_start:
        row.last_credit_grant_period_start = period_start

    db.add(
        Invoice(
            organization_id=row.organization_id,
            stripe_invoice_id=invoice["id"],
            amount_due_micros=int(invoice.get("amount_due", 0)) * 10_000,  # Stripe pence -> micro-GBP
            amount_paid_micros=int(invoice.get("amount_paid", 0)) * 10_000,
            status=invoice.get("status", "paid"),
            hosted_invoice_url=invoice.get("hosted_invoice_url"),
        )
    )
    db.flush()


def handle_invoice_payment_failed(db: Session, event: dict) -> None:
    invoice = event["data"]["object"]
    stripe_sub_id = invoice.get("subscription")
    if not stripe_sub_id:
        return
    row = db.execute(
        select(Subscription).where(Subscription.stripe_subscription_id == stripe_sub_id)
    ).scalar_one_or_none()
    if row:
        row.status = SubscriptionStatus.PAYMENT_FAILED
        db.flush()
