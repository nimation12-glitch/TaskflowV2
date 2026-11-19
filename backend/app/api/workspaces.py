from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from typing import Literal, Optional

from app.auth.internal import RequestContext, require_context
from app.auth.maintenance import block_if_maintenance_unless_admin
from app.database import get_db
from app.models.compute import BookingDuration, MachineImage, PaymentMode
from app.models.org import Organization
from app.models.workspace import StorageBillingMode, StorageSize
from app.services import workspace_storage
from app.services import workspaces as workspace_service
from app.services import gpu_rentals as gpu_rental_service
from app.services.gpu_rentals import get_plan_for_org

router = APIRouter(prefix="/workspaces", tags=["compute"], dependencies=[Depends(block_if_maintenance_unless_admin)])

_BILLING_MODE_FROM_API = {
    "hourly": StorageBillingMode.HOURLY,
    "prepaid_30d": StorageBillingMode.PREPAID_30D,
}

# Service errors -> HTTP statuses. One table keeps the handlers thin; anything
# unmapped falls back to 400 so a new service error can never surface as 500.
_ERROR_STATUS = {
    workspace_service.WorkspaceNotFoundError: 404,
    workspace_service.SshKeyNotFoundError: 404,
    workspace_service.StorageSizeNotOfferedError: 400,
    workspace_service.StorageSizeNotAvailableError: 400,
    workspace_service.InsufficientWalletBalanceError: 402,
    workspace_service.WorkspaceSlotLimitError: 409,
    workspace_service.WorkspaceHasActiveRentalError: 409,
    workspace_service.InvalidWorkspaceStateError: 409,
}

# Rental (GPU launch) errors, mapped the same way. Every one of these raised
# during workspace creation rolls the WHOLE request back — the customer asked
# for a workspace with a GPU, and gets neither (plus a clear reason) if the
# GPU cannot start. No money moves before AWS accepts the launch.
_RENTAL_ERROR_STATUS = {
    gpu_rental_service.GpuTierNotFoundError: 404,
    gpu_rental_service.SshKeyNotFoundError: 400,
    gpu_rental_service.WorkspaceNotFoundError: 404,
    gpu_rental_service.ConcurrentRentalLimitError: 409,
    gpu_rental_service.StorageLimitExceededError: 400,
    gpu_rental_service.BookingNotAllowedError: 403,
    gpu_rental_service.BookingDurationExceededError: 400,
    gpu_rental_service.InsufficientWalletBalanceError: 402,
    gpu_rental_service.NoRegionAvailableError: 503,
    gpu_rental_service.InvalidQuantityError: 400,
    gpu_rental_service.InvalidRentalStateError: 409,
    gpu_rental_service.ProvisioningFailedError: 502,
}

_PAYMENT_MODE_FROM_API = {"pay_as_you_go": PaymentMode.PAY_AS_YOU_GO, "booking": PaymentMode.BOOKING}
_BOOKING_DURATION_FROM_API = {"day": BookingDuration.DAY, "week": BookingDuration.WEEK}


class StartGpuRequest(BaseModel):
    """Attach (or start) the workspace's GPU — the money part of a workspace."""

    gpu_type_slug: str
    # N identical GPUs as one order (1..10); plan concurrency is re-checked
    # server-side against the whole order.
    quantity: int = Field(default=1, ge=1, le=10)
    payment_mode: Literal["pay_as_you_go", "booking"] = "pay_as_you_go"
    booking_duration: Optional[Literal["day", "week"]] = None
    # Spec §13: customers pick a GPU, not a region — may only hint at one.
    location_preference: Literal["automatic", "uk", "europe", "north_america", "asia"] = "automatic"


class CreateWorkspaceRequest(BaseModel):
    name: str
    storage_size_gb: int
    ssh_key_id: Optional[str] = None
    billing_mode: Literal["hourly", "prepaid_30d"] = "hourly"
    # Machine image this workspace boots (image catalogue). None = platform default.
    image_slug: Optional[str] = None
    # When present, the workspace is created AND its GPU booted in one
    # request: all-or-nothing (any failure rolls the workspace back too) and
    # billing starts only once AWS actually runs the machine.
    gpu: Optional[StartGpuRequest] = None


class ResizeWorkspaceRequest(BaseModel):
    storage_size_gb: int


class AttachSshKeyRequest(BaseModel):
    ssh_key_id: str


def _serialize(db: Session, ws) -> dict:
    plan = get_plan_for_org(db, ws.organization_id)
    return workspace_service.serialize_workspace(db, ws, plan)


def _raise_for_service_error(exc: workspace_service.WorkspaceError):
    status = next((code for cls, code in _ERROR_STATUS.items() if isinstance(exc, cls)), 400)
    raise HTTPException(status, str(exc))


def _parse_uuid(value: Optional[str], field: str) -> Optional[uuid.UUID]:
    if value is None:
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(400, f"Invalid {field}")


def _resolve_image(db: Session, image_slug: Optional[str]) -> Optional[MachineImage]:
    """The image catalogue row for a slug (None = platform default)."""
    if image_slug:
        image = db.execute(
            select(MachineImage).where(MachineImage.slug == image_slug, MachineImage.enabled == True)  # noqa: E712
        ).scalar_one_or_none()
        if image is None:
            raise HTTPException(400, "Unknown machine image")
        return image
    return gpu_rental_service.resolve_launch_image(db, None)


def _instance_storage_gb(workspace_storage_gb: int) -> int:
    """
    The GPU instance's root volume size: the workspace's own storage size
    when it is a legal rental storage option (so what the customer picked is
    what actually boots), else the included 100GB default. Workspace storage
    itself is billed by the workspace — this only sizes the real EBS volume
    behind the running machine.
    """
    if workspace_storage_gb in gpu_rental_service.ALLOWED_STORAGE_OPTIONS_GB:
        return workspace_storage_gb
    return 100


def _launch_workspace_gpu(db: Session, ctx: RequestContext, ws, req: StartGpuRequest) -> Optional[str]:
    """
    Boots the workspace's GPU (creates N GpuInstance rows and provisions them
    in AWS). Returns the Stripe checkout URL for booking mode, else None.

    Raises mapped GpuRentalError — the caller decides whether the whole
    request rolls back (workspace creation) or only the GPU part (start GPU).
    """
    org = db.get(Organization, ctx.organization_id)
    if org is None:
        raise HTTPException(404, "Organization not found")

    result = gpu_rental_service.create_rental(
        db,
        organization_id=ctx.organization_id,
        user_id=ctx.user_id,
        org=org,
        gpu_type_slug=req.gpu_type_slug,
        storage_gb=_instance_storage_gb(ws.storage_size_gb),
        ssh_key_id=None,  # a workspace launch always inherits the workspace's key
        payment_mode=_PAYMENT_MODE_FROM_API[req.payment_mode],
        booking_duration=_BOOKING_DURATION_FROM_API.get(req.booking_duration) if req.booking_duration else None,
        workspace_id=ws.id,
        location_preference=req.location_preference,
        quantity=req.quantity,
    )
    return result.checkout_url


def _raise_for_rental_error(exc: gpu_rental_service.GpuRentalError):
    status = next((code for cls, code in _RENTAL_ERROR_STATUS.items() if isinstance(exc, cls)), 400)
    message = str(exc)
    if isinstance(exc, gpu_rental_service.SshKeyNotFoundError):
        message = "This workspace has no SSH key yet — add one before starting a GPU"
    raise HTTPException(status, message)


@router.get("")
def list_workspaces(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    plan = get_plan_for_org(db, ctx.organization_id)
    rows = workspace_service.list_org_workspaces(db, ctx.organization_id)
    for ws in rows:
        # Lazy metering — every read catches up storage billing (spec §7:
        # billed while the workspace exists, GPU or not).
        workspace_storage.bill_workspace_storage(db, ws)
    db.commit()
    return {
        "workspaces": [workspace_service.serialize_workspace(db, ws, plan) for ws in rows],
        "slots": {"used": len(rows), "included": plan.included_workspaces},
    }


@router.get("/catalogue/storage")
def storage_catalogue(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    """Storage sizes the caller's plan can actually pick right now."""
    plan = get_plan_for_org(db, ctx.organization_id)
    rows = list(db.execute(select(StorageSize).order_by(StorageSize.size_gb)).scalars())
    sizes = []
    for row in rows:
        is_included = row.size_gb == plan.workspace_storage_gb
        if not (is_included or (row.enabled and plan.code.value in (row.available_plans or []))):
            continue
        sizes.append(
            {
                "size_gb": row.size_gb,
                "display_name": row.display_name,
                "hourly_price_micros": 0 if is_included else row.hourly_price_micros,
                "prepaid_price_micros": None if is_included else row.prepaid_price_micros,
                "is_included": is_included,
            }
        )
    return {"sizes": sizes}


@router.post("")
def create_workspace(
    body: CreateWorkspaceRequest,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    """
    Create a workspace — optionally with its GPU booted in the same request.

    All-or-nothing when a GPU is requested: workspace rows, GPU rows, the
    wallet/Stripe movements and the AWS launch share one transaction, so any
    failure leaves NOTHING behind (and no money has moved — AWS only accepts
    the launch after every check has passed).
    """
    image = _resolve_image(db, body.image_slug)
    try:
        ws = workspace_service.create_workspace(
            db,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            name=body.name,
            storage_size_gb=body.storage_size_gb,
            ssh_key_id=_parse_uuid(body.ssh_key_id, "ssh_key_id"),
            billing_mode=_BILLING_MODE_FROM_API[body.billing_mode],
            image_id=image.id if image is not None else None,
        )
        checkout_url = None
        gpu_started = False
        if body.gpu is not None:
            checkout_url = _launch_workspace_gpu(db, ctx, ws, body.gpu)
            gpu_started = True
        db.commit()
    except workspace_service.WorkspaceError as exc:
        db.rollback()
        _raise_for_service_error(exc)
    except gpu_rental_service.GpuRentalError as exc:
        # Workspace creation is undone too — the customer asked for a
        # workspace WITH a GPU and must not be left half-provisioned.
        db.rollback()
        _raise_for_rental_error(exc)

    payload = _serialize(db, ws)
    payload["checkout_url"] = checkout_url
    payload["gpu_started"] = gpu_started
    return payload


@router.post("/{workspace_id}/gpu")
def start_workspace_gpu(
    workspace_id: str,
    body: StartGpuRequest,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    """
    Start (or add) a GPU on an existing workspace. Unlike workspace creation,
    a failure here only rolls back the GPU attempt — the workspace and its
    storage stay exactly as they were, so the customer can retry.
    """
    wid = _parse_uuid(workspace_id, "workspace id")
    if wid is None:
        raise HTTPException(400, "Invalid workspace id")

    ws = workspace_service.get_org_workspace(db, ctx.organization_id, wid)
    if ws is None:
        raise HTTPException(404, "Workspace not found")
    if ws.status != workspace_service.WorkspaceStatus.ACTIVE:
        raise HTTPException(409, "Workspace is deleted")

    try:
        checkout_url = _launch_workspace_gpu(db, ctx, ws, body)
        db.commit()
    except workspace_service.WorkspaceError as exc:
        db.rollback()
        _raise_for_service_error(exc)
    except gpu_rental_service.GpuRentalError as exc:
        db.rollback()
        _raise_for_rental_error(exc)

    payload = _serialize(db, ws)
    payload["checkout_url"] = checkout_url
    payload["gpu_started"] = True
    return payload


@router.get("/{workspace_id}")
def get_workspace(
    workspace_id: str,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    wid = _parse_uuid(workspace_id, "workspace id")
    if wid is None:
        raise HTTPException(400, "Invalid workspace id")
    ws = workspace_service.get_org_workspace(db, ctx.organization_id, wid)
    if ws is None:
        raise HTTPException(404, "Workspace not found")
    workspace_storage.bill_workspace_storage(db, ws)
    db.commit()
    return _serialize(db, ws)


@router.post("/{workspace_id}/storage")
def resize_workspace(
    workspace_id: str,
    body: ResizeWorkspaceRequest,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    wid = _parse_uuid(workspace_id, "workspace id")
    try:
        ws = workspace_service.resize_workspace(db, ctx.organization_id, wid, body.storage_size_gb)
        db.commit()
    except workspace_service.WorkspaceError as exc:
        db.rollback()
        _raise_for_service_error(exc)
    return _serialize(db, ws)


@router.post("/{workspace_id}/prepaid")
def buy_prepaid(
    workspace_id: str,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    wid = _parse_uuid(workspace_id, "workspace id")
    try:
        ws = workspace_service.buy_prepaid(db, ctx.organization_id, wid)
        db.commit()
    except workspace_service.WorkspaceError as exc:
        db.rollback()
        _raise_for_service_error(exc)
    return _serialize(db, ws)


@router.post("/{workspace_id}/ssh-key")
def attach_ssh_key(
    workspace_id: str,
    body: AttachSshKeyRequest,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    wid = _parse_uuid(workspace_id, "workspace id")
    key_uuid = _parse_uuid(body.ssh_key_id, "ssh_key_id")
    try:
        ws = workspace_service.attach_ssh_key(db, ctx.organization_id, wid, key_uuid)
        db.commit()
    except workspace_service.WorkspaceError as exc:
        db.rollback()
        _raise_for_service_error(exc)
    return _serialize(db, ws)


@router.delete("/{workspace_id}")
def delete_workspace(
    workspace_id: str,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    wid = _parse_uuid(workspace_id, "workspace id")
    try:
        ws = workspace_service.delete_workspace(db, ctx.organization_id, wid)
        db.commit()
    except workspace_service.WorkspaceError as exc:
        db.rollback()
        _raise_for_service_error(exc)
    return _serialize(db, ws)
