from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Enum, ForeignKey, Integer, JSON, String
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin


class GpuTier(str, enum.Enum):
    """
    Access/performance tiers per the product spec (§9, §33). A family may
    appear in more than one tier's catalogue, but each SKU is assigned the
    LOWEST tier that lists it, so plan gating is a simple rank comparison:
    a plan can launch any SKU whose tier rank <= plan.gpu_max_tier rank.
    """

    STARTER = "STARTER"
    STANDARD = "STANDARD"
    PRO = "PRO"
    ULTRA = "ULTRA"

    @classmethod
    def rank(cls, tier: "GpuTier") -> int:
        return list(cls).index(tier)


class GpuType(UUIDPKMixin, TimestampMixin, Base):
    """
    The GPU rental catalogue. Data-driven like Plan/ModelPricing — never
    hardcode tier specs/prices in route handlers. Seeded defaults live in
    scripts/seed.py and must stay in sync with frontend/lib/gpu-catalog-reference.ts
    (marketing copy) and frontend/lib/compute-types.ts (GpuTier["slug"] union).
    """

    __tablename__ = "gpu_types"

    slug: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    gpu_label: Mapped[str] = mapped_column(String(100), nullable=False)  # e.g. "NVIDIA A10G", for display only

    # Access tier this SKU belongs to (lowest tier listing it — see GpuTier).
    tier: Mapped[GpuTier] = mapped_column(Enum(GpuTier, name="gputier"), default=GpuTier.STARTER, nullable=False)
    # Number of physical GPUs in this configuration (multi-GPU SKUs are one
    # rental, never independent per-GPU rentals — spec §10.5).
    gpu_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    aws_instance_type: Mapped[str] = mapped_column(String(50), nullable=False)  # e.g. "g5.xlarge"
    aws_region: Mapped[str] = mapped_column(String(30), nullable=False)
    ami_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)  # must be filled in before enabling

    vram_gb: Mapped[int] = mapped_column(Integer, nullable=False)
    vcpu: Mapped[int] = mapped_column(Integer, nullable=False)
    ram_gb: Mapped[int] = mapped_column(Integer, nullable=False)

    price_micros_per_hour: Mapped[int] = mapped_column(BigInteger, nullable=False)  # base rate, pre-plan-discount
    aws_cost_micros_per_hour: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)  # internal margin tracking only, never exposed
    # Internal safe-cost ceiling (spec §11/§19): the scheduler must refuse to
    # provision when projected infrastructure cost exceeds this — never rent
    # at a loss just to keep an availability label.
    safe_infrastructure_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    # Customer-facing minimum rental before launch (spec §20). 1 hour at launch.
    minimum_rental_hours: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # Per-tier override of GPU_MAX_RUNTIME_HOURS_DEFAULT. NULL = use the default.
    max_runtime_hours: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class MachineImage(UUIDPKMixin, TimestampMixin, Base):
    """
    The machine-image catalogue (spec: image catalogue inside the GPU
    catalogue). Every image is a real, public AWS Deep Learning AMI resolved
    per region at launch — AWS does not charge for public DLAMIs, so the
    platform does not either: hourly_price_micros is always 0 and the UI
    shows the image as Free. An image is chosen WITH a workspace (it rides
    along on Workspace.image_id), never as a separate boot flow.

    `name_pattern` is the ec2:DescribeImages name glob used to resolve the
    regional AMI for this image (AMI ids are regional — §15); `ssm_parameter`
    is an optional public SSM parameter tried first when the image has one.
    """

    __tablename__ = "machine_images"

    slug: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    # DescribeImages name glob, e.g. "Deep Learning OSS Nvidia Driver AMI GPU
    # PyTorch 2.13 (Amazon Linux 2023)*".
    name_pattern: Mapped[str] = mapped_column(String(200), nullable=False)
    # Optional public SSM parameter for this image (None = DescribeImages only).
    ssm_parameter: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # AWS public DLAMIs are free, so every catalogue image is free with us.
    # Kept as a column (always 0) so the UI can show the price honestly and a
    # future paid image (e.g. a commercial AMI) needs no schema change.
    hourly_price_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # Exactly one image is the platform default (the one a workspace gets when
    # the customer picks none).
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


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
    # Persistent workspace this rental is attached to (spec §22: rentals
    # reference the workspace, they don't own it). NULL for rentals created
    # before workspaces existed. At launch only ONE active rental may be
    # attached to a workspace at a time (spec §22) — enforced in
    # gpu_rentals.create_rental.
    workspace_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("workspaces.id"), nullable=True, index=True
    )

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
    # Launch geography (spec §13: customers pick a GPU, not a region; the
    # scheduler picks it). NULL for legacy rows launched before regions
    # existed — those implicitly ran in settings.aws_region.
    region_code: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    availability_zone: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # Snapshotted regional service premium included in hourly_rate_micros
    # (spec §24: base + premium + [storage] = customer price). Snapshot at
    # launch; later premium changes never retroactively reprice a running
    # rental (same rule as hourly_rate_micros).
    regional_premium_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

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
    # EC2 key pairs are REGIONAL resources. This records which regions the
    # key has been imported into (see ensure_aws_key_pair) — a key used for a
    # Stockholm launch must exist in eu-north-1, not just us-east-1. Legacy
    # rows have a name but an empty list: they were imported into
    # settings.aws_region only.
    aws_key_pair_regions: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
