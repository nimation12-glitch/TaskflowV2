from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.database import get_db
from app.services import gpu_rentals as gpu_rental_service

router = APIRouter(prefix="/compute", tags=["compute"])


@router.get("/gpu-types")
def list_gpu_types(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    """
    Returns the enabled GPU catalog with pricing already adjusted for the
    calling organization's plan discount, so the frontend doesn't need to
    duplicate that math — both the base rate and effective rate are
    returned for transparency. The server always recomputes this at rental
    creation time regardless of what the client saw here.
    """
    plan = gpu_rental_service.get_plan_for_org(db, ctx.organization_id)
    gpu_types = gpu_rental_service.list_enabled_gpu_types(db)

    return {
        "gpu_types": [
            {
                "slug": gt.slug,
                "display_name": gt.display_name,
                "gpu": gt.gpu_label,
                "vram_gb": gt.vram_gb,
                "vcpu": gt.vcpu,
                "ram_gb": gt.ram_gb,
                "base_price_micros_per_hour": gt.price_micros_per_hour,
                "effective_price_micros_per_hour": gpu_rental_service.discounted_base_rate_micros(gt, plan),
            }
            for gt in gpu_types
        ]
    }
