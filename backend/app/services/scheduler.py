"""
Automatic region + Availability Zone selection (spec §12-§14, §19-§20).

Customers select a GPU, never an AWS region (§13). They may optionally give a
location preference; Automatic is the default. This module turns the
(SKU x region) catalogue matrix into an ordered list of viable launch
candidates; gpu_rentals.create_rental walks that list until AWS accepts a
launch, falling back to the next region on InsufficientInstanceCapacity.

Candidate viability is the spec §19 intersection:
    configuration + regional availability + AMI compatibility + storage
    support + SSH support + safe infrastructure cost
Capacity is checked by AWS itself at launch time — that is the one input this
module cannot know up front, which is exactly why the caller has a fallback
loop instead of trusting the first candidate.

Ordering follows §13's priority list, minus what is already a hard filter:
    1. viable capacity            -> enforced by the caller's launch loop
    2. compatible environment/AMI -> enforced here (unresolvable AMI = out)
    3. acceptable startup time    -> measured p50 per region (§14)
    4. customer location preference -> hard filter here
    5. infrastructure economics   -> lower premium first (tie-break)
    6. balanced capacity use      -> deferred: needs per-AZ telemetry; AWS
       picks the AZ today and we record it on the rental for later balancing.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.compute import ami_resolver
from app.compute.ami_resolver import AmiResolutionError
from app.models.compute import GpuInstance, GpuTier, GpuType
from app.models.region import GpuRegionAvailability, GpuRegionStatus, Region, RegionStatus

logger = logging.getLogger("taskflow.scheduler")

# Spec §13's location preferences. "automatic" matches every region.
LOCATION_PREFERENCE_API_VALUES = ("automatic", "uk", "europe", "north_america", "asia")
_PREFERENCE_TO_AREA = {
    "uk": "UK",
    "europe": "Europe",
    "north_america": "North America",
    "asia": "Asia",
}

# Spec §20: "High-cost GPUs such as A100/H100 may also require stronger wallet
# reserves before launch." Every ULTRA-tier SKU is an A100/H100 configuration,
# so the reserve is derived from the tier rather than hardcoded slugs — a
# future ULTRA-tier SKU inherits the rule automatically.
ULTRA_RESERVE_HOURS = 4

# §14: startup estimates are displayed as estimates, not promises. With no
# measured data for a region yet (brand-new region / no completed launches),
# a conservative default is used and the real p50 takes over as data accrues.
DEFAULT_STARTUP_SECONDS = 90.0
STARTUP_SAMPLE_SIZE = 50


class NoRegionAvailableError(Exception):
    """
    Spec §19: no supported region is currently within the safe-cost/AMI/
    availability thresholds for this configuration -> "Temporarily
    unavailable". Never silently launch at a loss or on a guessed AMI.
    """


@dataclass
class LaunchCandidate:
    region_code: str
    premium_micros: int
    ami_id: str
    startup_estimate_seconds: float


def reserve_hours_for(gpu_type: GpuType) -> int:
    """Minimum wallet cover before launch, in hours (§20)."""
    hours = gpu_type.minimum_rental_hours or 1
    if gpu_type.tier == GpuTier.ULTRA:
        hours = max(hours, ULTRA_RESERVE_HOURS)
    return max(hours, 1)


def reserve_amount_micros(gpu_type: GpuType, hourly_rate_micros: int) -> int:
    return hourly_rate_micros * reserve_hours_for(gpu_type)


def customer_hourly_rate_micros(gpu_type: GpuType, plan, premium_micros: int, storage_gb: int) -> int:
    """
    Spec §24: fixed base (after plan discount) + regional premium + storage
    add-on = customer hourly price. The premium is never plan-discounted.
    """
    from app.services import gpu_rentals

    return (
        gpu_rentals.discounted_base_rate_micros(gpu_type, plan)
        + premium_micros
        + gpu_rentals.storage_add_on_micros(storage_gb)
    )


def _as_aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _startup_p50_seconds(db: Session, region_code: str) -> float:
    """
    Measured platform data (§14): wall time from provisioning start to the
    instance actually RUNNING, for recent launches in this region. Median of
    the most recent sample; DEFAULT_STARTUP_SECONDS when there is no data yet.
    """
    rows = db.execute(
        select(GpuInstance.provisioning_started_at, GpuInstance.started_at)
        .where(
            GpuInstance.region_code == region_code,
            GpuInstance.started_at.is_not(None),
            GpuInstance.provisioning_started_at.is_not(None),
        )
        .order_by(GpuInstance.started_at.desc())
        .limit(STARTUP_SAMPLE_SIZE)
    ).all()
    deltas = sorted(
        (_as_aware(started) - _as_aware(begun)).total_seconds()
        for begun, started in rows
        if _as_aware(started) >= _as_aware(begun)
    )
    if not deltas:
        return DEFAULT_STARTUP_SECONDS
    return deltas[len(deltas) // 2]


def startup_estimates_by_region(db: Session) -> dict[str, float]:
    """
    §14 startup estimates for every region in one query — the catalogue
    endpoint uses this to show "usually ready in ~X min" without 6 queries
    per SKU. Same p50-of-recent-launches rule as _startup_p50_seconds.
    """
    rows = db.execute(
        select(
            GpuInstance.region_code,
            GpuInstance.provisioning_started_at,
            GpuInstance.started_at,
        )
        .where(
            GpuInstance.region_code.is_not(None),
            GpuInstance.started_at.is_not(None),
            GpuInstance.provisioning_started_at.is_not(None),
        )
        .order_by(GpuInstance.started_at.desc())
        .limit(STARTUP_SAMPLE_SIZE * 12)
    ).all()
    per_region: dict[str, list[float]] = {}
    for region_code, begun, started in rows:
        if _as_aware(started) < _as_aware(begun):
            continue
        sample = per_region.setdefault(region_code, [])
        if len(sample) < STARTUP_SAMPLE_SIZE:
            sample.append((_as_aware(started) - _as_aware(begun)).total_seconds())
    return {
        region: sorted(deltas)[len(deltas) // 2]
        for region, deltas in per_region.items()
        if deltas
    }


def list_viable_rows(
    db: Session,
    gpu_type: GpuType,
    *,
    location_preference: str = "automatic",
    require_storage: bool = False,
) -> Optional[list[tuple[GpuRegionAvailability, Region]]]:
    """
    The (availability_row, region) pairs that pass every hard filter. Returns
    None when the SKU has NO regional catalogue data at all — that is the
    legacy single-region shape (SKU pinned to settings.aws_region by
    GpuType.aws_region/ami_id), which callers may treat as a fallback path.
    An empty list means data exists but nothing is viable right now (§19
    "Temporarily unavailable").
    """
    area = _PREFERENCE_TO_AREA.get(location_preference)
    if location_preference != "automatic" and area is None:
        raise ValueError(f"Unknown location preference '{location_preference}'")

    query = (
        select(GpuRegionAvailability, Region)
        .join(Region, GpuRegionAvailability.region_id == Region.id)
        .where(
            GpuRegionAvailability.gpu_type_id == gpu_type.id,
            GpuRegionAvailability.status == GpuRegionStatus.AVAILABLE,
            Region.status == RegionStatus.AVAILABLE,
            Region.ssh_support == True,  # noqa: E712 - every launch needs SSH
        )
    )
    if area is not None:
        query = query.where(Region.country_or_area == area)
    if require_storage:
        query = query.where(Region.storage_support == True)  # noqa: E712

    rows = list(db.execute(query).all())
    if not rows:
        any_rows = (
            db.execute(
                select(GpuRegionAvailability.id).where(GpuRegionAvailability.gpu_type_id == gpu_type.id)
            ).first()
            is not None
        )
        if not any_rows:
            return None  # legacy: SKU has no regional matrix at all

    # Safe-cost policy (§19): refuse a region whose estimated infrastructure
    # cost exceeds the SKU's ceiling plus that region's own premium — a
    # premium legitimately covers regional economics; a cost overrun beyond
    # that does not, and the platform must not run at a loss to keep a
    # region's availability label.
    viable = [
        (row, region)
        for row, region in rows
        if row.aws_cost_est_micros_per_hour
        <= gpu_type.safe_infrastructure_cost_micros + row.premium_micros
    ]
    return viable


def select_region_candidates(
    db: Session,
    gpu_type: GpuType,
    *,
    location_preference: str = "automatic",
    require_storage: bool = False,
) -> Optional[list[LaunchCandidate]]:
    """
    Ordered launch candidates (best first), each with its AMI already
    resolved and cached. None = legacy no-matrix path; [] = nothing viable
    (caller should surface "temporarily unavailable", §19).
    """
    viable = list_viable_rows(
        db, gpu_type, location_preference=location_preference, require_storage=require_storage
    )
    if viable is None:
        return None

    candidates: list[LaunchCandidate] = []
    for row, region in viable:
        try:
            ami = ami_resolver.get_or_resolve_ami(db, row)
        except AmiResolutionError as exc:
            # No compatible environment profile in this region right now
            # (§15: a region is not eligible merely because AWS exposes the
            # GPU there). Skip it; the resolution error stays logged.
            logger.warning("Region %s skipped for '%s': %s", region.aws_region_code, gpu_type.slug, exc)
            continue
        candidates.append(
            LaunchCandidate(
                region_code=region.aws_region_code,
                premium_micros=row.premium_micros,
                ami_id=ami,
                startup_estimate_seconds=_startup_p50_seconds(db, region.aws_region_code),
            )
        )

    if not candidates:
        return []

    candidates.sort(
        key=lambda c: (c.startup_estimate_seconds, c.premium_micros, c.region_code)
    )
    return candidates
