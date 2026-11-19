"""
Persistent workspaces + the storage catalogue (product spec §4, §6, §7, §22, §25).

A workspace is a persistent customer environment: named storage plus an SSH
identity that outlives every GPU rental. GPU rentals REFERENCE a workspace
(GpuInstance.workspace_id) but never own it, so the same workspace can be
re-attached to rental after rental.

Billing model (spec §7):
- A size equal to the org plan's included workspace_storage_gb is free and is
  never billed (Free 1x50GB, Pro/Ultra 500GB, Max 1TB per workspace).
- Any other size is PAID and is billed hourly for as long as the workspace
  exists — whether its GPU is running, stopped or released — or prepaid in
  30-day blocks drawn from the wallet up front.
- Workspace slots are hard account-level limits (Plan.included_workspaces);
  deleting a workspace releases the slot (§25).
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin


class WorkspaceStatus(str, enum.Enum):
    """ACTIVE occupies a plan slot; DELETED releases it (soft delete — spec §25)."""

    ACTIVE = "ACTIVE"
    DELETED = "DELETED"


class StorageBillingMode(str, enum.Enum):
    """
    HOURLY: wallet-metered while the workspace exists (spec §7).
    PREPAID_30D: one-off 30-day commitment drawn from the wallet up front
    (spec §7: extra commercial margin for committed revenue). On expiry the
    sweep reverts the workspace to hourly metering — customer data is never
    silently destroyed because a commitment lapsed.
    """

    HOURLY = "HOURLY"
    PREPAID_30D = "PREPAID_30D"


class StorageSize(UUIDPKMixin, TimestampMixin, Base):
    """
    Persistent-storage catalogue (spec §7 storage pricing table). Prices are
    fixed launch prices: `hourly_price_micros` per hour while the workspace
    exists (charged only for PAID sizes), `prepaid_price_micros` as a one-off
    30-day commitment.

    `available_plans` holds the PlanCode values allowed to pick this size —
    the per-plan size matrix (Free: 50/100/250 GB; Pro/Ultra: 500 GB/1/2/5 TB;
    Max: 1/2/5/10 TB). "Included" state is NOT stored here: a size is included
    for a plan exactly when size_gb == Plan.workspace_storage_gb, so there is
    only one source of truth for each plan's entitlement.

    enabled=False means "not yet backed by real storage provisioning" — the
    same deliberate rollout switch GpuType.enabled uses. A plan's INCLUDED
    size is always creatable regardless of this flag (it is a plan
    entitlement and is never billed).
    """

    __tablename__ = "storage_sizes"

    size_gb: Mapped[int] = mapped_column(Integer, unique=True, index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(50), nullable=False)  # e.g. "500 GB", "1 TB"
    hourly_price_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)
    prepaid_price_micros: Mapped[int] = mapped_column(BigInteger, nullable=False)  # one-off, covers 30 days
    available_plans: Mapped[list] = mapped_column(JSON, nullable=False, default=list)  # PlanCode values, e.g. ["PRO", "ULTRA"]
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class Workspace(UUIDPKMixin, TimestampMixin, Base):
    """
    One persistent workspace (spec §22 data model). Tenant isolation is
    mandatory on every query touching this table (WHERE organization_id ==
    ctx.organization_id) — never trust a client-supplied ID alone.
    """

    __tablename__ = "workspaces"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    storage_size_gb: Mapped[int] = mapped_column(Integer, nullable=False)
    # Real backing volume id once provisioning lands (Phase 3 scheduler).
    # NULL = logical allocation only.
    storage_volume_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # Persistent SSH identity for this workspace (spec §5/§22). Optional at
    # creation; attachable/replaceable later via the workspace API.
    ssh_key_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("ssh_keys.id"), nullable=True
    )

    # Machine image this workspace boots (image catalogue: images ride along
    # with the workspace, they are never a separate flow). NULL = the platform
    # default image. Snapshotted at creation; the image's regional AMI is
    # resolved at GPU launch time (AMI ids are regional — spec §15).
    image_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("machine_images.id"), nullable=True
    )

    billing_mode: Mapped[StorageBillingMode] = mapped_column(
        Enum(StorageBillingMode, name="storagebillingmode"),
        default=StorageBillingMode.HOURLY,
        nullable=False,
    )
    prepaid_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    status: Mapped[WorkspaceStatus] = mapped_column(
        Enum(WorkspaceStatus, name="workspacestatus"),
        default=WorkspaceStatus.ACTIVE,
        nullable=False,
        index=True,
    )
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    # Snapshotted hourly rate at creation/resize time (0 for included sizes).
    # Never recompute from current catalogue prices — later price changes must
    # not retroactively affect an existing workspace's billing (same rule as
    # GpuInstance.hourly_rate_micros).
    hourly_rate_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    # Lazy metering (see app/services/workspace_storage.py) — same pattern as
    # GpuInstance.last_billed_at: charged on read + by the safety sweep.
    last_billed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    total_charged_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    # Set when a full hourly charge could not be applied (wallet empty).
    # Storage is never auto-deleted for debt — customer data persists (spec §4:
    # the workspace remains with its storage while it exists) — so overdue
    # workspaces are flagged here for admin review instead.
    payment_overdue_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    ssh_key: Mapped[Optional["SshKey"]] = relationship()
