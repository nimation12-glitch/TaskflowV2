from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Literal, Optional

from app.auth.internal import RequestContext, require_context
from app.database import get_db
from app.models.compute import BookingDuration, GpuInstance, PaymentMode
from app.models.org import Organization
from app.services import gpu_billing
from app.services import gpu_rentals as gpu_rental_service
from app.services import ssh_keys as ssh_key_service

router = APIRouter(prefix="/compute/rentals", tags=["compute"])

_PAYMENT_MODE_TO_API = {PaymentMode.PAY_AS_YOU_GO: "pay_as_you_go", PaymentMode.BOOKING: "booking"}
_PAYMENT_MODE_FROM_API = {v: k for k, v in _PAYMENT_MODE_TO_API.items()}
_BOOKING_DURATION_FROM_API = {"day": BookingDuration.DAY, "week": BookingDuration.WEEK}


class CreateRentalRequest(BaseModel):
    gpu_type_slug: str
    storage_gb: int
    ssh_key_id: str
    payment_mode: Literal["pay_as_you_go", "booking"]
    booking_duration: Optional[Literal["day", "week"]] = None


def _serialize(instance: GpuInstance, db: Session) -> dict:
    ssh_key = ssh_key_service.get_org_ssh_key(db, instance.organization_id, instance.ssh_key_id)
    accrued_cost_micros = instance.total_charged_micros if instance.payment_mode == PaymentMode.PAY_AS_YOU_GO else None
    return {
        "id": str(instance.id),
        "gpu_type_slug": instance.gpu_type.slug if instance.gpu_type else None,
        "storage_gb": instance.storage_gb,
        "status": instance.status.value,
        "payment_mode": _PAYMENT_MODE_TO_API[instance.payment_mode],
        "ssh_key_id": str(instance.ssh_key_id),
        "ssh_key_label": ssh_key.label if ssh_key else None,
        "public_ip": instance.public_ip,
        "started_at": instance.started_at.isoformat() if instance.started_at else None,
        "created_at": instance.created_at.isoformat(),
        "accrued_cost_micros": accrued_cost_micros,
        "booking_expires_at": instance.booking_expires_at.isoformat() if instance.booking_expires_at else None,
        "error_detail": instance.error_detail,
        "hourly_rate_micros": instance.hourly_rate_micros,
    }


@router.get("")
def list_rentals(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    rentals = gpu_rental_service.list_org_rentals(db, ctx.organization_id)
    for instance in rentals:
        gpu_billing.refresh_and_bill(db, instance)
    db.commit()
    return {"rentals": [_serialize(r, db) for r in rentals]}


@router.post("")
def create_rental(
    body: CreateRentalRequest,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    org = db.get(Organization, ctx.organization_id)
    if not org:
        raise HTTPException(404, "Organization not found")

    try:
        ssh_key_uuid = uuid.UUID(body.ssh_key_id)
    except ValueError:
        raise HTTPException(400, "Invalid ssh_key_id")

    payment_mode = _PAYMENT_MODE_FROM_API[body.payment_mode]
    booking_duration = _BOOKING_DURATION_FROM_API.get(body.booking_duration) if body.booking_duration else None

    try:
        result = gpu_rental_service.create_rental(
            db,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            org=org,
            gpu_type_slug=body.gpu_type_slug,
            storage_gb=body.storage_gb,
            ssh_key_id=ssh_key_uuid,
            payment_mode=payment_mode,
            booking_duration=booking_duration,
        )
        db.commit()
    except (gpu_rental_service.GpuTierNotFoundError, gpu_rental_service.SshKeyNotFoundError) as exc:
        db.rollback()
        raise HTTPException(404, str(exc))
    except gpu_rental_service.StorageLimitExceededError as exc:
        db.rollback()
        raise HTTPException(400, str(exc))
    except gpu_rental_service.BookingDurationExceededError as exc:
        db.rollback()
        raise HTTPException(400, str(exc))
    except gpu_rental_service.BookingNotAllowedError as exc:
        db.rollback()
        raise HTTPException(403, str(exc))
    except gpu_rental_service.ConcurrentRentalLimitError as exc:
        db.rollback()
        raise HTTPException(409, str(exc))
    except gpu_rental_service.InsufficientWalletBalanceError as exc:
        db.rollback()
        raise HTTPException(402, str(exc))
    except gpu_rental_service.ProvisioningFailedError as exc:
        # The GpuInstance row was already committed as FAILED inside the
        # service before this was raised, so the failure is visible in the
        # user's rental history rather than vanishing.
        raise HTTPException(502, f"AWS provisioning failed: {exc}")

    if result.checkout_url:
        return {"checkout_url": result.checkout_url}
    return _serialize(result.instance, db)


@router.post("/{rental_id}/stop")
def stop_rental(
    rental_id: str,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    rid = _parse_uuid(rental_id)
    try:
        instance = gpu_rental_service.stop_rental(db, ctx.organization_id, rid)
        db.commit()
    except gpu_rental_service.RentalNotFoundError:
        raise HTTPException(404, "Rental not found")
    except gpu_rental_service.InvalidRentalStateError as exc:
        db.rollback()
        raise HTTPException(409, str(exc))
    return _serialize(instance, db)


@router.post("/{rental_id}/start")
def start_rental(
    rental_id: str,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    rid = _parse_uuid(rental_id)
    try:
        instance = gpu_rental_service.start_rental(db, ctx.organization_id, rid)
        db.commit()
    except gpu_rental_service.RentalNotFoundError:
        raise HTTPException(404, "Rental not found")
    except gpu_rental_service.InsufficientWalletBalanceError as exc:
        db.rollback()
        raise HTTPException(402, str(exc))
    except gpu_rental_service.InvalidRentalStateError as exc:
        db.rollback()
        raise HTTPException(409, str(exc))
    return _serialize(instance, db)


@router.delete("/{rental_id}")
def terminate_rental(
    rental_id: str,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    rid = _parse_uuid(rental_id)
    try:
        instance = gpu_rental_service.terminate_rental(db, ctx.organization_id, rid)
        db.commit()
    except gpu_rental_service.RentalNotFoundError:
        raise HTTPException(404, "Rental not found")
    except gpu_rental_service.InvalidRentalStateError as exc:
        db.rollback()
        raise HTTPException(409, str(exc))
    return _serialize(instance, db)


def _parse_uuid(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(400, "Invalid rental id")
