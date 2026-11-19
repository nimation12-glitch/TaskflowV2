"""
Workspace CRUD + entitlement enforcement (spec §4, §6, §7, §22, §25).

Route handlers (app/api/workspaces.py) stay thin and delegate here — mirrors
app/services/gpu_rentals.py. Every plan entitlement (workspace slots, the
per-plan size matrix, the included size) is re-derived from the org's actual
subscription here — never trusted from the request body.

Money rules:
- Included-size workspaces (size == Plan.workspace_storage_gb) are NEVER
  billed — that is the plan entitlement.
- Paid sizes charge the plan's fixed catalogue prices: hourly while the
  workspace exists, or one-off 30-day prepaid drawn from the wallet.
- A prepaid commitment can't be bought for an included size (already free).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.billing import CreditTransactionType, Plan
from app.models.compute import GpuInstance, GpuInstanceStatus, MachineImage, SshKey
from app.models.workspace import StorageBillingMode, StorageSize, Workspace, WorkspaceStatus
from app.services import credits as credits_service
from app.services import ssh_keys as ssh_key_service
from app.services import workspace_storage
from app.services.gpu_rentals import get_plan_for_org

PREPAID_DAYS = 30

# One active compute attachment per workspace at launch (spec §22).
_ACTIVE_RENTAL_STATUSES = (
    GpuInstanceStatus.PROVISIONING,
    GpuInstanceStatus.RUNNING,
    GpuInstanceStatus.STOPPED,
)


class WorkspaceError(Exception):
    """Base class for every workspace-service error. Each maps to a specific
    HTTP status in app/api/workspaces.py."""


class WorkspaceNotFoundError(WorkspaceError):
    pass


class WorkspaceSlotLimitError(WorkspaceError):
    pass


class StorageSizeNotOfferedError(WorkspaceError):
    """Size exists in the catalogue but is not offered on this plan."""


class StorageSizeNotAvailableError(WorkspaceError):
    """Size is offered on this plan but not yet enabled for paid use."""


class SshKeyNotFoundError(WorkspaceError):
    pass


class InsufficientWalletBalanceError(WorkspaceError):
    pass


class WorkspaceHasActiveRentalError(WorkspaceError):
    pass


class InvalidWorkspaceStateError(WorkspaceError):
    pass


def count_active_workspaces(db: Session, organization_id: uuid.UUID) -> int:
    return len(
        db.execute(
            select(Workspace.id).where(
                Workspace.organization_id == organization_id,
                Workspace.status == WorkspaceStatus.ACTIVE,
            )
        ).all()
    )


def get_org_workspace(db: Session, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> Workspace | None:
    """Tenant-scoped lookup — every workspace fetch in the API layer must go through this."""
    return db.execute(
        select(Workspace).where(Workspace.id == workspace_id, Workspace.organization_id == organization_id)
    ).scalar_one_or_none()


def list_org_workspaces(db: Session, organization_id: uuid.UUID) -> list[Workspace]:
    return list(
        db.execute(
            select(Workspace)
            .where(Workspace.organization_id == organization_id, Workspace.status == WorkspaceStatus.ACTIVE)
            .order_by(Workspace.created_at.desc())
        ).scalars()
    )


def workspace_has_active_rental(db: Session, workspace_id: uuid.UUID) -> bool:
    return (
        db.execute(
            select(GpuInstance.id).where(
                GpuInstance.workspace_id == workspace_id,
                GpuInstance.status.in_(_ACTIVE_RENTAL_STATUSES),
            )
        ).first()
        is not None
    )


def resolve_storage_size(db: Session, plan: Plan, size_gb: int) -> tuple[StorageSize, bool]:
    """
    Validates a storage size against the org's plan (spec §7 matrix) and
    returns (catalogue_row, is_included). Raises StorageSizeNotOfferedError /
    StorageSizeNotAvailableError. The plan's included size is always allowed
    even when the catalogue row is still disabled — it is an entitlement and
    is never billed.
    """
    row = db.execute(select(StorageSize).where(StorageSize.size_gb == size_gb)).scalar_one_or_none()
    if row is None:
        raise StorageSizeNotOfferedError(f"{size_gb}GB is not a workspace storage size")
    is_included = size_gb == plan.workspace_storage_gb
    if not is_included:
        if plan.code.value not in (row.available_plans or []):
            raise StorageSizeNotOfferedError(
                f"{row.display_name} storage is not offered on the {plan.display_name} plan"
            )
        if not row.enabled:
            raise StorageSizeNotAvailableError(f"{row.display_name} storage is not available yet")
    return row, is_included


def create_workspace(
    db: Session,
    *,
    organization_id: uuid.UUID,
    user_id: uuid.UUID,
    name: str,
    storage_size_gb: int,
    ssh_key_id: Optional[uuid.UUID] = None,
    billing_mode: StorageBillingMode = StorageBillingMode.HOURLY,
    image_id: Optional[uuid.UUID] = None,
) -> Workspace:
    plan = get_plan_for_org(db, organization_id)

    name_clean = (name or "").strip()
    if not name_clean or len(name_clean) > 100:
        raise InvalidWorkspaceStateError("Workspace name must be 1-100 characters")

    # Hard account-level slot limit (spec §25) — deleting a workspace releases
    # its slot; extra slots are not sold.
    if count_active_workspaces(db, organization_id) >= plan.included_workspaces:
        raise WorkspaceSlotLimitError(
            f"Your plan includes {plan.included_workspaces} workspace(s). "
            "Delete one to free a slot, or upgrade your plan."
        )

    size_row, is_included = resolve_storage_size(db, plan, storage_size_gb)

    mode = billing_mode
    if is_included and mode == StorageBillingMode.PREPAID_30D:
        raise InvalidWorkspaceStateError(
            "This storage size is already included in your plan — it cannot be prepaid"
        )

    ssh_key = None
    if ssh_key_id is not None:
        ssh_key = ssh_key_service.get_org_ssh_key(db, organization_id, ssh_key_id)
        if ssh_key is None:
            raise SshKeyNotFoundError("SSH key not found")

    # The machine image rides along with the workspace (image catalogue).
    # Unknown/disabled slugs are rejected by the API layer; NULL means the
    # platform default image at launch time.
    if image_id is not None and db.get(MachineImage, image_id) is None:
        raise InvalidWorkspaceStateError("Unknown machine image")

    hourly_rate_micros = 0 if is_included else size_row.hourly_price_micros

    account = credits_service.get_or_create_account(db, organization_id)
    if not is_included:
        if mode == StorageBillingMode.PREPAID_30D:
            if account.balance_micros < size_row.prepaid_price_micros:
                raise InsufficientWalletBalanceError(
                    "Your wallet balance won't cover the 30-day prepaid price — top up your wallet first"
                )
        elif account.balance_micros < hourly_rate_micros:
            raise InsufficientWalletBalanceError(
                "Your wallet balance won't cover an hour of this storage — top up your wallet first"
            )

    now = datetime.now(timezone.utc)
    ws = Workspace(
        id=uuid.uuid4(),
        organization_id=organization_id,
        created_by_user_id=user_id,
        name=name_clean,
        storage_size_gb=size_row.size_gb,
        ssh_key_id=ssh_key.id if ssh_key else None,
        image_id=image_id,
        billing_mode=mode,
        status=WorkspaceStatus.ACTIVE,
        hourly_rate_micros=hourly_rate_micros,
        last_billed_at=now,
    )
    db.add(ws)
    db.flush()

    if mode == StorageBillingMode.PREPAID_30D:
        # record_transaction re-validates the balance authoritatively under
        # the row lock (the earlier check was advisory).
        credits_service.record_transaction(
            db,
            organization_id=organization_id,
            type=CreditTransactionType.STORAGE_PREPAID,
            amount_micros=-size_row.prepaid_price_micros,
            description=f"30-day prepaid storage — {size_row.display_name} ({ws.name})",
            allow_overdraft=False,
            workspace_id=ws.id,
        )
        ws.prepaid_expires_at = now + timedelta(days=PREPAID_DAYS)
        db.flush()

    return ws


def resize_workspace(
    db: Session, organization_id: uuid.UUID, workspace_id: uuid.UUID, new_storage_size_gb: int
) -> Workspace:
    ws = get_org_workspace(db, organization_id, workspace_id)
    if ws is None:
        raise WorkspaceNotFoundError("Workspace not found")
    if ws.status != WorkspaceStatus.ACTIVE:
        raise InvalidWorkspaceStateError("Workspace is deleted")
    if ws.billing_mode == StorageBillingMode.PREPAID_30D:
        raise InvalidWorkspaceStateError(
            "Storage size can't change during a prepaid period — it expires back to hourly billing"
        )

    # Settle outstanding hours at the OLD rate before re-pricing.
    workspace_storage.bill_workspace_storage(db, ws)

    plan = get_plan_for_org(db, organization_id)
    size_row, is_included = resolve_storage_size(db, plan, new_storage_size_gb)
    if size_row.size_gb == ws.storage_size_gb:
        return ws

    ws.storage_size_gb = size_row.size_gb
    ws.hourly_rate_micros = 0 if is_included else size_row.hourly_price_micros
    ws.last_billed_at = datetime.now(timezone.utc)  # new rate starts now
    db.flush()
    return ws


def attach_ssh_key(
    db: Session, organization_id: uuid.UUID, workspace_id: uuid.UUID, ssh_key_id: uuid.UUID
) -> Workspace:
    ws = get_org_workspace(db, organization_id, workspace_id)
    if ws is None:
        raise WorkspaceNotFoundError("Workspace not found")
    if ws.status != WorkspaceStatus.ACTIVE:
        raise InvalidWorkspaceStateError("Workspace is deleted")
    key = ssh_key_service.get_org_ssh_key(db, organization_id, ssh_key_id)
    if key is None:
        raise SshKeyNotFoundError("SSH key not found")
    ws.ssh_key_id = key.id
    db.flush()
    return ws


def buy_prepaid(db: Session, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> Workspace:
    """Switches an hourly paid workspace to a 30-day prepaid commitment."""
    ws = get_org_workspace(db, organization_id, workspace_id)
    if ws is None:
        raise WorkspaceNotFoundError("Workspace not found")
    if ws.status != WorkspaceStatus.ACTIVE:
        raise InvalidWorkspaceStateError("Workspace is deleted")
    if ws.billing_mode == StorageBillingMode.PREPAID_30D:
        raise InvalidWorkspaceStateError("Workspace is already prepaid")

    plan = get_plan_for_org(db, organization_id)
    if ws.storage_size_gb == plan.workspace_storage_gb:
        raise InvalidWorkspaceStateError(
            "This storage size is already included in your plan — it cannot be prepaid"
        )

    size_row = db.execute(
        select(StorageSize).where(StorageSize.size_gb == ws.storage_size_gb)
    ).scalar_one_or_none()
    if size_row is None or not size_row.enabled:
        raise StorageSizeNotAvailableError("Prepaid storage is not available for this size yet")

    # Settle outstanding hourly metering before switching modes.
    workspace_storage.bill_workspace_storage(db, ws)

    credits_service.record_transaction(
        db,
        organization_id=organization_id,
        type=CreditTransactionType.STORAGE_PREPAID,
        amount_micros=-size_row.prepaid_price_micros,
        description=f"30-day prepaid storage — {size_row.display_name} ({ws.name})",
        allow_overdraft=False,
        workspace_id=ws.id,
    )
    ws.billing_mode = StorageBillingMode.PREPAID_30D
    now = datetime.now(timezone.utc)
    ws.prepaid_expires_at = now + timedelta(days=PREPAID_DAYS)
    ws.last_billed_at = now
    db.flush()
    return ws


def delete_workspace(db: Session, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> Workspace:
    """
    Soft delete: releases the plan slot immediately (spec §25) and stops all
    future storage billing. Blocked while an active GPU rental is attached.
    """
    ws = get_org_workspace(db, organization_id, workspace_id)
    if ws is None:
        raise WorkspaceNotFoundError("Workspace not found")
    if ws.status != WorkspaceStatus.ACTIVE:
        raise InvalidWorkspaceStateError("Workspace is already deleted")

    if workspace_has_active_rental(db, ws.id):
        raise WorkspaceHasActiveRentalError(
            "Terminate the GPU attached to this workspace before deleting it"
        )

    # Settle final storage hours at the current rate before the flag flips.
    workspace_storage.bill_workspace_storage(db, ws)

    ws.status = WorkspaceStatus.DELETED
    ws.deleted_at = datetime.now(timezone.utc)
    db.flush()
    return ws


def serialize_workspace(db: Session, ws: Workspace, plan: Plan) -> dict:
    size_row = db.execute(
        select(StorageSize).where(StorageSize.size_gb == ws.storage_size_gb)
    ).scalar_one_or_none()
    is_included = ws.storage_size_gb == plan.workspace_storage_gb

    ssh_key = None
    if ws.ssh_key_id is not None:
        ssh_key = ssh_key_service.get_org_ssh_key(db, ws.organization_id, ws.ssh_key_id)

    image = db.get(MachineImage, ws.image_id) if ws.image_id is not None else None

    active_rentals = db.execute(
        select(GpuInstance.id).where(
            GpuInstance.workspace_id == ws.id,
            GpuInstance.status.in_(_ACTIVE_RENTAL_STATUSES),
        )
    ).scalars().all()

    return {
        "id": str(ws.id),
        "name": ws.name,
        "storage_size_gb": ws.storage_size_gb,
        "storage_display_name": size_row.display_name if size_row else f"{ws.storage_size_gb} GB",
        "is_included": is_included,
        "billing_mode": ws.billing_mode.value,
        "hourly_rate_micros": ws.hourly_rate_micros,
        "prepaid_price_micros": None if is_included or size_row is None else size_row.prepaid_price_micros,
        "prepaid_expires_at": ws.prepaid_expires_at.isoformat() if ws.prepaid_expires_at else None,
        "ssh_key_id": str(ws.ssh_key_id) if ws.ssh_key_id else None,
        "ssh_key_label": ssh_key.label if ssh_key else None,
        # Machine image this workspace boots (NULL = platform default).
        "image_id": str(ws.image_id) if ws.image_id else None,
        "image_slug": image.slug if image else None,
        "image_display_name": image.display_name if image else None,
        "status": ws.status.value,
        "created_at": ws.created_at.isoformat(),
        "deleted_at": ws.deleted_at.isoformat() if ws.deleted_at else None,
        "total_charged_micros": ws.total_charged_micros,
        "payment_overdue": ws.payment_overdue_at is not None,
        # A workspace may host several active rentals (multi-GPU orders share
        # one workspace) — id kept for legacy callers, count for the UI.
        "active_gpu_instance_id": str(active_rentals[0]) if active_rentals else None,
        "active_gpu_count": len(active_rentals),
    }
