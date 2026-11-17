"""
Real Stripe billing. No simulated fallback exists anywhere in this module —
if STRIPE_SECRET_KEY is not set, every function here raises rather than
pretending to succeed.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

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
from app.models.compute import BookingDuration, GpuInstance, GpuInstanceStatus, SshKey
from app.models.org import Organization
from app.models.region import Region
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

# Settings attribute holding the recurring Stripe Price id for each paid plan
# (spec §2: Free £0 / Pro £35 / Ultra £65 / Max £100).
SUBSCRIPTION_PRICE_ATTRS = {
    PlanCode.PRO: "stripe_price_pro",
    PlanCode.ULTRA: "stripe_price_ultra",
    PlanCode.MAX: "stripe_price_max",
}

# What the buyer is actually purchasing, shown on the Stripe checkout page
# (custom_text.submit renders beside the pay button; subscription_data
# .description travels onto the subscription and its invoices). Plans buy
# ACCESS (spec §3) — GPU time itself is always paid from the wallet.
PLAN_CHECKOUT_TEXT = {
    PlanCode.PRO: {
        "submit": "You're subscribing to TaskFlow Pro: 3 concurrent GPU rentals, 250 GB storage, 7-day bookings. GPU time is paid from your wallet.",
        "description": "TaskFlow Pro plan — 3 concurrent GPU rentals, 250 GB storage, 7-day bookings. Billed monthly; GPU time is paid from your wallet.",
    },
    PlanCode.ULTRA: {
        "submit": "You're subscribing to TaskFlow Ultra: 6 concurrent GPU rentals, 500 GB storage, 14-day bookings. GPU time is paid from your wallet.",
        "description": "TaskFlow Ultra plan — 6 concurrent GPU rentals, 500 GB storage, 14-day bookings. Billed monthly; GPU time is paid from your wallet.",
    },
    PlanCode.MAX: {
        "submit": "You're subscribing to TaskFlow Max: 10 concurrent GPU rentals, 1 TB storage, 14-day bookings. GPU time is paid from your wallet.",
        "description": "TaskFlow Max plan — 10 concurrent GPU rentals, 1 TB storage, 14-day bookings. Billed monthly; GPU time is paid from your wallet.",
    },
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
    """Returns a Stripe Checkout URL for a Pro/Ultra/Max subscription."""
    client = _client()
    attr = SUBSCRIPTION_PRICE_ATTRS.get(plan_code)
    price_id = getattr(settings, attr) if attr else ""
    if not price_id:
        raise BillingNotConfiguredError(f"No Stripe price configured for plan {plan_code}")

    customer_id = get_or_create_stripe_customer(db, org, email)
    checkout_text = PLAN_CHECKOUT_TEXT[plan_code]

    session = client.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=f"{settings.app_base_url}/dashboard/billing?checkout=success",
        cancel_url=f"{settings.app_base_url}/dashboard/billing?checkout=cancelled",
        custom_text={"submit": {"message": checkout_text["submit"]}},
        metadata={"organization_id": str(org.id), "plan": plan_code.value, "purchase_type": "subscription"},
        subscription_data={
            "description": checkout_text["description"],
            "metadata": {"organization_id": str(org.id), "plan": plan_code.value},
        },
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
        custom_text={
            "submit": {"message": f"Adds £{amount_micros / 1_000_000:g} of credit to your workspace — spend it on GPU compute rentals."}
        },
        payment_intent_data={"description": f"TaskFlow credit purchase — £{amount_micros / 1_000_000:g} added to wallet"},
        metadata={
            "organization_id": str(org.id),
            "purchase_type": "credit_purchase",
            "amount_micros": str(amount_micros),
        },
    )
    return session["url"]


def _existing_stripe_customer_id(db: Session, org: Organization) -> str | None:
    row = db.execute(select(StripeCustomer).where(StripeCustomer.organization_id == org.id)).scalar_one_or_none()
    return row.stripe_customer_id if row else None


def _backfill_stripe_customer(db: Session, org_id: uuid.UUID, session: dict) -> None:
    """
    The wallet-topup/GPU-booking flows below don't have an email to pass
    up front — the frontend's topUpWallet()/createRental() calls carry none,
    since identity lives in a separate Next.js/Prisma database and the
    backend JWT only carries sub/org_id/role. So unlike
    create_subscription_checkout_session/create_credit_purchase_checkout_session,
    we can't call get_or_create_stripe_customer before checkout. Instead we
    reuse an existing customer if this org already has one, and otherwise
    ask Stripe to create one during checkout (customer_creation="always"),
    persisting it here once the webhook confirms payment so a later top-up
    or the billing portal can reuse it.
    """
    customer_id = session.get("customer")
    if not customer_id:
        return
    existing = db.execute(select(StripeCustomer).where(StripeCustomer.organization_id == org_id)).scalar_one_or_none()
    if existing:
        return
    db.add(StripeCustomer(organization_id=org_id, stripe_customer_id=customer_id))
    db.flush()


def create_wallet_topup_checkout_session(db: Session, org: Organization, amount_micros: int) -> str:
    """
    Wallet top-ups reuse the exact same Stripe Price IDs and package amounts
    as the legacy credit purchase flow (STRIPE_PRICE_CREDIT_10/25/50/100) —
    the underlying ledger mechanism is unchanged, only the user-facing label
    is "wallet" now.
    """
    client = _client()
    attr_name = CREDIT_PACKAGE_PRICE_IDS.get(amount_micros)
    if not attr_name:
        raise ValueError("Unsupported wallet top-up amount")
    price_id = getattr(settings, attr_name)
    if not price_id:
        raise BillingNotConfiguredError(f"No Stripe price configured for wallet top-up amount {amount_micros}")

    session_kwargs: dict = dict(
        mode="payment",
        line_items=[{"price": price_id, "quantity": 1}],
        success_url=f"{settings.app_base_url}/dashboard/compute?checkout=success",
        cancel_url=f"{settings.app_base_url}/dashboard/compute?checkout=cancelled",
        custom_text={
            "submit": {"message": f"Adds £{amount_micros / 1_000_000:g} of wallet credit — pays for GPU compute rentals and never expires."}
        },
        payment_intent_data={"description": f"TaskFlow wallet top-up — £{amount_micros / 1_000_000:g} added to wallet"},
        metadata={
            "organization_id": str(org.id),
            "purchase_type": "wallet_topup",
            "amount_micros": str(amount_micros),
        },
    )
    existing_customer_id = _existing_stripe_customer_id(db, org)
    if existing_customer_id:
        session_kwargs["customer"] = existing_customer_id
    else:
        session_kwargs["customer_creation"] = "always"

    session = client.checkout.Session.create(**session_kwargs)
    return session["url"]


def create_gpu_booking_checkout_session(
    db: Session, org: Organization, instance: GpuInstance, gpu_type, amount_micros: int
) -> str:
    """
    Booking totals are dynamic (tier x duration x storage add-on), so unlike
    subscriptions/credit packages this uses an ad hoc Stripe price_data line
    item rather than a pre-created Price ID. Metadata carries the pending
    GpuInstance.id so the webhook can find and provision it — see
    handle_checkout_completed's "gpu_booking" branch, which is idempotency-
    guarded against webhook retries (a retry must never double-provision).
    """
    client = _client()
    if amount_micros <= 0:
        raise ValueError("Booking amount must be positive")
    amount_pence = amount_micros // 10_000  # micro-GBP -> pence (inverse of handle_invoice_paid's conversion)

    duration_label = "24 hours" if instance.booking_duration == BookingDuration.DAY else "7 days"

    # Resolve the region's public name for the checkout copy — the buyer
    # should see where their GPU will live, not an AWS region code.
    region_label = instance.region_code
    if instance.region_code:
        region_row = db.execute(
            select(Region).where(Region.aws_region_code == instance.region_code)
        ).scalar_one_or_none()
        if region_row is not None:
            region_label = region_row.public_name

    booking_description = (
        f"{gpu_type.display_name} rental in {region_label}, {instance.storage_gb} GB storage. "
        f"Fixed {duration_label} booking — charged upfront, auto-terminates when the period ends."
    )

    session_kwargs: dict = dict(
        mode="payment",
        line_items=[
            {
                "price_data": {
                    "currency": "gbp",
                    "product_data": {
                        "name": f"{gpu_type.display_name} GPU booking — {duration_label}",
                        "description": booking_description,
                    },
                    "unit_amount": amount_pence,
                },
                "quantity": 1,
            }
        ],
        success_url=f"{settings.app_base_url}/dashboard/compute?checkout=success",
        cancel_url=f"{settings.app_base_url}/dashboard/compute?checkout=cancelled",
        custom_text={
            "submit": {"message": "You're booking a fixed rental period — the total is charged now and the instance auto-terminates when it ends."}
        },
        metadata={
            "organization_id": str(org.id),
            "purchase_type": "gpu_booking",
            "gpu_instance_id": str(instance.id),
        },
    )
    existing_customer_id = _existing_stripe_customer_id(db, org)
    if existing_customer_id:
        session_kwargs["customer"] = existing_customer_id
    else:
        session_kwargs["customer_creation"] = "always"

    session = client.checkout.Session.create(**session_kwargs)
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
    elif purchase_type == "wallet_topup":
        amount_micros = int(metadata.get("amount_micros", "0"))
        if amount_micros <= 0:
            return
        _backfill_stripe_customer(db, org_id, session)
        credits_service.record_transaction(
            db,
            organization_id=org_id,
            type=CreditTransactionType.PURCHASE,
            amount_micros=amount_micros,
            description=f"Wallet top-up (£{amount_micros / 1_000_000:.2f})",
            stripe_event_id=event["id"],
            stripe_payment_intent_id=session.get("payment_intent"),
            stripe_checkout_session_id=session.get("id"),
        )
    elif purchase_type == "gpu_booking":
        gpu_instance_id_raw = metadata.get("gpu_instance_id")
        if not gpu_instance_id_raw:
            return
        instance = db.get(GpuInstance, uuid.UUID(gpu_instance_id_raw))
        if instance is None:
            return
        if instance.status != GpuInstanceStatus.PENDING_PAYMENT:
            # Idempotency guard: a webhook retry (or a replayed event) must
            # never double-provision an already-provisioned booking.
            return

        _backfill_stripe_customer(db, org_id, session)

        hours = 24 if instance.booking_duration == BookingDuration.DAY else 24 * 7
        instance.booking_expires_at = datetime.now(timezone.utc) + timedelta(hours=hours)

        from app.compute import aws_provider
        from app.compute import ami_resolver
        from app.models.region import GpuRegionAvailability, Region
        from app.services import ssh_keys as ssh_key_service

        ssh_key = db.get(SshKey, instance.ssh_key_id)
        try:
            aws_key_pair_name = ssh_key_service.ensure_aws_key_pair(db, ssh_key, region_name=instance.region_code)
            ami_id = None
            if instance.region_code:
                # Launch in the region the customer was quoted for (§13/§24).
                # The scheduler already resolved and cached the regional AMI
                # when the booking was created; this refreshes it if the TTL
                # lapsed between checkout and payment.
                availability = db.execute(
                    select(GpuRegionAvailability)
                    .join(Region, GpuRegionAvailability.region_id == Region.id)
                    .where(
                        GpuRegionAvailability.gpu_type_id == instance.gpu_type_id,
                        Region.aws_region_code == instance.region_code,
                    )
                ).scalar_one_or_none()
                if availability is not None:
                    ami_id = ami_resolver.get_or_resolve_ami(db, availability)
            aws_instance_id, _initial_state, availability_zone = aws_provider.launch_instance(
                instance.gpu_type,
                instance.storage_gb,
                aws_key_pair_name,
                tags={
                    "Name": f"taskflow-{instance.id}",
                    "taskflow:gpu_instance_id": str(instance.id),
                    "taskflow:organization_id": str(org_id),
                },
                region_name=instance.region_code,
                ami_id=ami_id,
            )
        except aws_provider.AwsProviderError as exc:
            # Stripe has already captured payment at this point. A failed
            # provisioning after payment needs a human to refund via the
            # Stripe dashboard — this is not built as an automatic refund
            # flow. Never silently pretend the booking succeeded.
            instance.status = GpuInstanceStatus.FAILED
            instance.error_detail = f"Provisioning failed after payment — needs manual refund review: {exc}"[:500]
            db.flush()
            return

        instance.aws_instance_id = aws_instance_id
        instance.availability_zone = availability_zone
        instance.status = GpuInstanceStatus.PROVISIONING
        instance.provisioning_started_at = datetime.now(timezone.utc)
        db.flush()


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
    Subscriptions buy ACCESS, not compute (product spec §3): no wallet credits
    are granted here — GPU time is always wallet-metered from top-ups. This
    handler records the payment document (an Invoice row carrying Stripe's
    hosted receipt link, which the account statement mirrors) and marks the
    subscription ACTIVE.

    Dedupe: the StripeEvent idempotency table stops the same webhook event
    from being processed twice; the per-invoice existence check below adds a
    second layer so a replayed or re-delivered invoice can never create a
    duplicate payment record.
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

    row.status = SubscriptionStatus.ACTIVE

    existing_invoice = db.execute(
        select(Invoice).where(Invoice.stripe_invoice_id == invoice["id"])
    ).scalar_one_or_none()
    if existing_invoice is None:
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
