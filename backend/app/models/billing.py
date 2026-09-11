from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Enum, ForeignKey, Integer, String, JSON
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin

MICROS_PER_GBP = 1_000_000  # money is stored as integer micro-GBP everywhere. Never floats.


class PlanCode(str, enum.Enum):
    FREE = "FREE"
    PRO = "PRO"
    MAX = "MAX"


class Plan(UUIDPKMixin, TimestampMixin, Base):
    """
    Plan configuration is database-backed and editable without redeploying —
    numbers below are just the seeded defaults (see scripts/seed.py).
    """

    __tablename__ = "plans"

    code: Mapped[PlanCode] = mapped_column(Enum(PlanCode), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    monthly_price_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)
    monthly_credit_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)
    rate_limit_rpm: Mapped[int] = mapped_column(Integer, nullable=False)
    compute_priority: Mapped[int] = mapped_column(Integer, nullable=False)  # higher = more priority
    max_members: Mapped[int] = mapped_column(Integer, nullable=False)
    allows_gpu_rental: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    stripe_price_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)

    # --- GPU rental limits (see app/services/gpu_rentals.py — always enforced
    # server-side, never trust the frontend's greying-out alone) ---
    gpu_max_concurrent_rentals: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    gpu_max_storage_gb: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Hard ceiling on a single pay-as-you-go session's runtime. NULL = no
    # plan-specific cap beyond GPU_MAX_RUNTIME_HOURS_DEFAULT / GpuType override.
    gpu_max_session_hours: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    gpu_booking_allowed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    gpu_max_booking_days: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Basis points applied to the base hourly rate, e.g. 10000 = no discount,
    # 9000 = 10% off, 8000 = 20% off. Matches frontend's PLAN_LIMITS.ratesMultiplier.
    gpu_rate_bps: Mapped[int] = mapped_column(Integer, default=10_000, nullable=False)


class SubscriptionStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    TRIALING = "TRIALING"
    PAST_DUE = "PAST_DUE"
    PAYMENT_FAILED = "PAYMENT_FAILED"
    CANCELED = "CANCELED"
    INCOMPLETE = "INCOMPLETE"


class Subscription(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "subscriptions"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    plan_id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("plans.id"), nullable=False)
    status: Mapped[SubscriptionStatus] = mapped_column(
        Enum(SubscriptionStatus), default=SubscriptionStatus.ACTIVE, nullable=False
    )
    stripe_subscription_id: Mapped[Optional[str]] = mapped_column(String(120), unique=True, nullable=True)
    current_period_start: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    current_period_end: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_credit_grant_period_start: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )  # prevents double-granting monthly credits on retries/dashboard visits

    plan: Mapped["Plan"] = relationship()


class StripeCustomer(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "stripe_customers"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    stripe_customer_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)


class StripeEvent(UUIDPKMixin, Base):
    """Processed Stripe webhook events, for strict idempotency."""

    __tablename__ = "stripe_events"

    stripe_event_id: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    event_type: Mapped[str] = mapped_column(String(120), nullable=False)
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)


class Invoice(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "invoices"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stripe_invoice_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    amount_due_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)
    amount_paid_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False)
    hosted_invoice_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)


class CreditAccount(UUIDPKMixin, TimestampMixin, Base):
    """
    Balance is a transactional aggregate, always kept consistent with the
    append-only CreditTransaction ledger (see services/credits.py). We never
    just mutate this number without writing a corresponding ledger row.
    """

    __tablename__ = "credit_accounts"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    balance_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)


class CreditTransactionType(str, enum.Enum):
    MONTHLY_GRANT = "MONTHLY_GRANT"
    PURCHASE = "PURCHASE"
    USAGE = "USAGE"
    GPU_USAGE = "GPU_USAGE"
    ADJUSTMENT = "ADJUSTMENT"
    REFUND = "REFUND"


class CreditTransaction(UUIDPKMixin, Base):
    __tablename__ = "credit_transactions"

    id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    type: Mapped[CreditTransactionType] = mapped_column(Enum(CreditTransactionType), nullable=False)
    amount_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)  # positive=credit, negative=debit
    balance_after_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    # Audit metadata — never invent these, only populate from verified sources.
    stripe_event_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    stripe_payment_intent_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    stripe_checkout_session_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    usage_event_id: Mapped[Optional[uuid.UUID]] = mapped_column(PGUUID(as_uuid=True), nullable=True)
