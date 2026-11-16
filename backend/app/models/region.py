"""
Launch regions + per-configuration regional availability (spec §12, §19, §23).

Two tables:
- Region: the 6 launch regions. The record describes what the platform
  SUPPORTS; the scheduler checks what is actually available now (spec §23).
- GpuRegionAvailability: the (GPU SKU x region) matrix. Absence of a row =
  configuration not offered there; a row with status=DISABLED is the spec's
  explicit "N/A" and must never be offered (§12). The row carries the exact
  per-configuration regional service premium (the spec forbids blindly
  multiplying a family's 1-GPU premium by GPU count) and the regional AWS
  planning cost used by the safe-cost check (spec §19).
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin


class RegionStatus(str, enum.Enum):
    AVAILABLE = "AVAILABLE"
    DISABLED = "DISABLED"


class Region(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "regions"

    aws_region_code: Mapped[str] = mapped_column(String(30), unique=True, index=True, nullable=False)
    public_name: Mapped[str] = mapped_column(String(100), nullable=False)  # e.g. "UK London"
    # Location-preference group (spec §13: Automatic / UK / Europe /
    # North America / Asia). Automatic matches everything.
    country_or_area: Mapped[str] = mapped_column(String(50), nullable=False)

    # Platform capability flags (spec §19 intersection list). The scheduler
    # only considers regions where the requested SKU's requirements are met.
    storage_support: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    ssh_support: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    status: Mapped[RegionStatus] = mapped_column(
        Enum(RegionStatus, name="regionstatus"), default=RegionStatus.AVAILABLE, nullable=False
    )


class GpuRegionStatus(str, enum.Enum):
    AVAILABLE = "AVAILABLE"
    # The spec's "N/A": must not be offered for this configuration, even if
    # AWS would technically launch there (spec §12).
    NOT_OFFERED = "NOT_OFFERED"


class GpuRegionAvailability(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "gpu_region_availability"
    __table_args__ = (UniqueConstraint("gpu_type_id", "region_id", name="uq_gpu_region"),)

    gpu_type_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("gpu_types.id", ondelete="CASCADE"), nullable=False, index=True
    )
    region_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("regions.id", ondelete="CASCADE"), nullable=False, index=True
    )

    status: Mapped[GpuRegionStatus] = mapped_column(
        Enum(GpuRegionStatus, name="gpuregionstatus"),
        default=GpuRegionStatus.AVAILABLE,
        nullable=False,
    )
    # Customer-facing regional service premium in micro-GBP/hour, added to the
    # SKU's fixed base price (spec §24). 0 for the baseline regions. Never
    # discounted by plans.
    premium_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    # Regional AWS infrastructure planning cost in micro-GBP/hour (internal,
    # never exposed). The scheduler refuses regions whose estimate exceeds the
    # SKU's safe_infrastructure_cost_micros ceiling (spec §19 safe-cost).
    aws_cost_est_micros_per_hour: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    # Regionally-resolved AMI id (spec §15: AMI ids are regional and must not
    # be copied between regions). Cached from SSM at launch; NULL until first
    # resolution. A NOT_OFFERED row never gets one.
    ami_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    ami_resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    gpu_type: Mapped["GpuType"] = relationship()
    region: Mapped["Region"] = relationship()
