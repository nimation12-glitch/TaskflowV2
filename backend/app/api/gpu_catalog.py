from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.auth.maintenance import block_if_maintenance_unless_admin
from app.compute.ami_resolver import AMI_DISPLAY_NAME, AMI_SSM_PATH
from app.database import get_db
from app.models.compute import GpuType, MachineImage
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

    Every seeded SKU is rentable: the regional AMI is resolved live at launch
    (SSM first, ec2:DescribeImages fallback — see app/compute/ami_resolver.py),
    so nothing in the catalogue is a placeholder and nothing is "coming soon".
    Rental creation still refuses disabled SKUs server-side as a safety net.

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
                "name": region.public_name,
                "area": region.country_or_area,
                "premium_micros": row.premium_micros,
                # Cached regional AMI (resolved via SSM at launch, §15) — null
                # until the first resolution. The catalogue shows it so users
                # can see exactly which machine image boots in each region.
                "ami_id": row.ami_id,
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
            # The machine image every launch boots (§15): one Deep Learning
            # AMI per region, resolved through SSM and cached per region.
            "image": {
                "name": AMI_DISPLAY_NAME,
                "ssm_parameter": AMI_SSM_PATH,
            },
            "regions": {
                "offered": offered,
                "not_offered": not_offered_by_sku.get(str(gt.id), []),
            },
        }

    return {
        "gpu_types": [_serialize(gt) for gt in gpu_types],
        # The caller's plan as the catalogue renders allowances against it
        # ("how many your plan allows" on a family's configurations).
        "plan": {
            "code": plan.code.value,
            "display_name": plan.display_name,
            "max_concurrent_rentals": plan.gpu_max_concurrent_rentals,
            "max_storage_gb": plan.gpu_max_storage_gb,
            "max_session_hours": plan.gpu_max_session_hours,
            "booking_allowed": plan.gpu_booking_allowed,
            "max_booking_days": plan.gpu_max_booking_days,
            "tier": plan.gpu_max_tier.value if plan.gpu_max_tier else None,
        },
    }


@router.get("/images")
def list_machine_images(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    """
    The machine-image catalogue (browsed inside the GPU catalogue page).

    Images ride along with a workspace (chosen in the workspace wizard — never
    a separate flow). Pricing rule: an image that is free on AWS is free here —
    every seeded row is a public AWS Deep Learning AMI, so hourly_price_micros
    is 0 and the UI shows it as free. A paid image in the future would simply
    seed a non-zero price; no code change needed.
    """
    images = list(
        db.execute(
            select(MachineImage)
            .where(MachineImage.enabled == True)  # noqa: E712
            .order_by(MachineImage.sort_order, MachineImage.display_name)
        ).scalars()
    )
    return {
        "images": [
            {
                "slug": image.slug,
                "display_name": image.display_name,
                "description": image.description,
                "hourly_price_micros": image.hourly_price_micros,
                "is_free": image.hourly_price_micros == 0,
                "is_default": image.is_default,
                "ssm_parameter": image.ssm_parameter,
            }
            for image in images
        ]
    }
