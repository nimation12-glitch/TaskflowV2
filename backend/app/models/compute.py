from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin


class GpuType(UUIDPKMixin, TimestampMixin, Base):
    """
    The GPU rental catalog. Data-driven like Plan/ModelPricing — never
    hardcode tier specs/prices in route handlers. Seeded defaults live in
    scripts/seed.py and must stay in sync with frontend/lib/gpu-catalog-reference.ts
    (marketing copy) and frontend/lib/compute-types.ts (GpuTier["slug"] union).
    """

    __tablename__ = "gpu_types"

    slug: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    gpu_label: Mapped[str] = mapped_column(String(100), nullable=False)  # e.g. "NVIDIA A10G", for display only

    aws_instance_type: Mapped[str] = mapped_column(String(50), nullable=False)  # e.g. "g5.xlarge"
    aws_region: Mapped[str] = mapped_column(String(30), nullable=False)
    ami_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)  # must be filled in before enabling

    vram_gb: Mapped[int] = mapped_column(Integer, nullable=False)
    vcpu: Mapped[int] = mapped_column(Integer, nullable=False)
    ram_gb: Mapped[int] = mapped_column(Integer, nullable=False)

    price_micros_per_hour: Mapped[int] = mapped_column(BigInteger, nullable=False)  # base rate, pre-plan-discount
    aws_cost_micros_per_hour: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)  # internal margin tracking only, never exposed

    # Per-tier override of GPU_MAX_RUNTIME_HOURS_DEFAULT. NULL = use the default.
    max_runtime_hours: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class GpuInstanceStatus(str, enum.Enum):
    PENDING_PAYMENT = "PENDING_PAYMENT"  # booking mode only, before Stripe confirms — never provisioned yet
    PROVISIONING = "PROVISIONING"
    RUNNING = "RUNNING"
    STOPPING = "STOPPING"
    STOPPED = "STOPPED"
    TERMINATING = "TERMINATING"
    TERMINATED = "TERMINATED"
    FAILED = "FAILED"


class PaymentMode(str, enum.Enum):
    PAY_AS_YOU_GO = "PAY_AS_YOU_GO"
    BOOKING = "BOOKING"


class BookingDuration(str, enum.Enum):
    DAY = "DAY"
    WEEK = "WEEK"


class GpuInstance(UUIDPKMixin, TimestampMixin, Base):
    """
    One GPU rental. Tenant isolation is mandatory on every query touching this
    table (WHERE organization_id == ctx.organization_id) — never trust a
    client-supplied ID alone. See app/services/gpu_rentals.py.
    """

    __tablename__ = "gpu_instances"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False)
    gpu_type_id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("gpu_types.id"), nullable=False)
    ssh_key_id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("ssh_keys.id"), nullable=False)

    status: Mapped[GpuInstanceStatus] = mapped_column(
        Enum(GpuInstanceStatus), default=GpuInstanceStatus.PENDING_PAYMENT, nullable=False, index=True
    )
    payment_mode: Mapped[PaymentMode] = mapped_column(Enum(PaymentMode), nullable=False)
    booking_duration: Mapped[Optional[BookingDuration]] = mapped_column(Enum(BookingDuration), nullable=True)
    booking_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    storage_gb: Mapped[int] = mapped_column(Integer, nullable=False)

    # Snapshotted at creation time (base rate x plan discount + storage add-on).
    # Never recompute from current catalog prices — later price/plan changes
    # must not retroactively affect an existing rental's billing.
    hourly_rate_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)

    aws_instance_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    public_ip: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    stopped_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    terminated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    provisioning_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # Lazy metering (see app/services/gpu_billing.py) — no background worker
    # assumed, so every read of a RUNNING rental catches up billing first.
    last_billed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    total_charged_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    error_detail: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    gpu_type: Mapped["GpuType"] = relationship()


class SshKey(UUIDPKMixin, Base):
    __tablename__ = "ssh_keys"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False)
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    public_key: Mapped[str] = mapped_column(String(4096), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(100), nullable=False)  # SHA256:base64, display-only
    # Cached AWS key pair name once imported (see aws_provider.import_ssh_key).
    # Imported lazily on first use, not at creation time.
    aws_key_pair_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
