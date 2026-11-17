from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.auth.maintenance import block_if_maintenance_unless_admin
from app.database import get_db
from app.models.compute import GpuType
from app.models.region import GpuRegionAvailability, GpuRegionStatus, Region, RegionStatus
from app.services import gpu_rentals as gpu_rental_service
from app.services import scheduler

router = APIRouter(prefix="/compute", tags=["compute"], dependencies=[Depends(block_if_maintenance_unless_admin)])


@router.get("/gpu-types")
def list_gpu_types(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    """
    Returns the full GPU catalogue for the catalogue UI.

    Every seeded SKU is included, also ones not yet rentable: a SKU carries
    enabled=False until its regional AMI is resolved (spec §15/§19 — nothing
    is sold that isn't really provisionable). The frontend shows those as
    "coming soon"; rental creation refuses them server-side regardless of
    what the client saw here.

    Pricing per §24: fixed base price, plan-adjusted effective base, and the
    per-region service premium list so the UI can decompose the hourly price,
    show a location preference (§13) and quote "from" prices. Internal AWS
    cost estimates never leave the backend.
    """
    plan = gpu_rental_service.get_plan_for_org(db, ctx.organization_id)
    gpu_types = list(
        db.execute(select(GpuType).order_by(GpuType.price_micros_per_hour, GpuType.slug)).scalars()
    )

    # One query for the whole visible (SKU x region) matrix; grouped in Python.
    matrix = db.execute(
        select(GpuRegionAvailability, Region)
        .join(Region, GpuRegionAvailability.region_id == Region.id)
        .where(Region.status == RegionStatus.AVAILABLE)
    ).all()
    offered_by_sku: dict[str, list[dict]] = {}
    not_offered_by_sku: dict[str, list[str]] = {}
    for row, region in matrix:
        if row.status == GpuRegionStatus.NOT_OFFERED:
            not_offered_by_sku.setdefault(str(row.gpu_type_id), []).append(region.aws_region_code)
            continue
        offered_by_sku.setdefault(str(row.gpu_type_id), []).append(
            {
                "code": region.aws_region_code,
                "area": region.country_or_area,
                "premium_micros": row.premium_micros,
            }
        )

    # §14: per-region startup estimates, one batched query for all regions.
    estimates = scheduler.startup_estimates_by_region(db)

    def _serialize(gt: GpuType) -> dict:
        offered = offered_by_sku.get(str(gt.id), [])
        for entry in offered:
            entry["startup_estimate_seconds"] = estimates.get(entry["code"], scheduler.DEFAULT_STARTUP_SECONDS)
        return {
            "slug": gt.slug,
            "display_name": gt.display_name,
            "gpu": gt.gpu_label,
            "vram_gb": gt.vram_gb,
            "vcpu": gt.vcpu,
            "ram_gb": gt.ram_gb,
            "gpu_count": gt.gpu_count,
            "tier": gt.tier.value,
            "enabled": gt.enabled,
            "base_price_micros_per_hour": gt.price_micros_per_hour,
            "effective_price_micros_per_hour": gpu_rental_service.discounted_base_rate_micros(gt, plan),
            "minimum_rental_hours": gt.minimum_rental_hours,
            "booking_allowed": plan.gpu_booking_allowed,
            "regions": {
                "offered": offered,
                "not_offered": not_offered_by_sku.get(str(gt.id), []),
            },
        }

    return {"gpu_types": [_serialize(gt) for gt in gpu_types]}
