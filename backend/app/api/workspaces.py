from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session
from typing import Literal, Optional

from app.auth.internal import RequestContext, require_context
from app.auth.maintenance import block_if_maintenance_unless_admin
from app.database import get_db
from app.models.workspace import StorageBillingMode, StorageSize
from app.services import workspace_storage
from app.services import workspaces as workspace_service
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


class CreateWorkspaceRequest(BaseModel):
    name: str
    storage_size_gb: int
    ssh_key_id: Optional[str] = None
    billing_mode: Literal["hourly", "prepaid_30d"] = "hourly"


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
    try:
        ws = workspace_service.create_workspace(
            db,
            organization_id=ctx.organization_id,
            user_id=ctx.user_id,
            name=body.name,
            storage_size_gb=body.storage_size_gb,
            ssh_key_id=_parse_uuid(body.ssh_key_id, "ssh_key_id"),
            billing_mode=_BILLING_MODE_FROM_API[body.billing_mode],
        )
        db.commit()
    except workspace_service.WorkspaceError as exc:
        db.rollback()
        _raise_for_service_error(exc)
    return _serialize(db, ws)


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
