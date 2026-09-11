from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context, require_role
from app.billing import stripe_service
from app.database import get_db
from app.models.compute import GpuInstance, GpuInstanceStatus, PaymentMode
from app.models.org import Organization, Role
from app.services import credits as credits_service
from app.services import gpu_billing

router = APIRouter(prefix="/compute", tags=["compute"])


class WalletTopupRequest(BaseModel):
    amount_micros: int


@router.get("/wallet")
def get_wallet(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    # Catch up billing on every running rental first so the balance shown is
    # accurate up to the second, not just whatever it was last time someone
    # loaded the rentals list.
    running = db.execute(
        select(GpuInstance).where(
            GpuInstance.organization_id == ctx.organization_id,
            GpuInstance.status == GpuInstanceStatus.RUNNING,
            GpuInstance.payment_mode == PaymentMode.PAY_AS_YOU_GO,
        )
    ).scalars().all()
    for instance in running:
        gpu_billing.bill_running_rental(db, instance)
    db.commit()

    account = credits_service.get_or_create_account(db, ctx.organization_id)

    estimated_hours_remaining_at_current_rate = None
    if running:
        total_rate = sum(r.hourly_rate_micros for r in running)
        if total_rate > 0:
            estimated_hours_remaining_at_current_rate = round(account.balance_micros / total_rate, 1)

    return {
        "balance_micros": account.balance_micros,
        "estimated_hours_remaining_at_current_rate": estimated_hours_remaining_at_current_rate,
    }


@router.post("/wallet/topup")
def topup_wallet(
    body: WalletTopupRequest,
    ctx: RequestContext = Depends(require_role(Role.OWNER)),
    db: Session = Depends(get_db),
):
    org = db.get(Organization, ctx.organization_id)
    if not org:
        raise HTTPException(404, "Organization not found")
    try:
        url = stripe_service.create_wallet_topup_checkout_session(db, org, body.amount_micros)
        db.commit()
    except stripe_service.BillingNotConfiguredError as exc:
        db.rollback()
        raise HTTPException(503, str(exc))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(400, str(exc))
    return {"checkout_url": url}
