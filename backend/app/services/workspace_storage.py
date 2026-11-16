"""
Lazy metering + safety sweep for persistent workspace storage (spec §7).

Mirrors app/services/gpu_billing.py: no background worker is assumed, so
every read of a workspace (list/get endpoints) catches up billing since
last_billed_at, and POST /internal/gpu/sweep (see app/api/internal.py) is the
load-bearing safety net for workspaces nobody is actively looking at.

Rules from the spec:
- Storage is billed while the workspace EXISTS — whether its GPU is running,
  stopped or released (spec §7 "Hourly storage billing").
- Included-size workspaces (size == plan.workspace_storage_gb, snapshotted as
  hourly_rate_micros=0) are never billed.
- Prepaid workspaces are not metered hourly; when their 30-day commitment
  expires the sweep reverts them to hourly metering, so customer data is
  never silently destroyed because a commitment lapsed.
- A workspace whose wallet cannot cover the charge is flagged overdue, never
  auto-deleted — deletion is always explicit (spec §25 deletion policy).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.billing import CreditTransactionType
from app.models.workspace import StorageBillingMode, Workspace, WorkspaceStatus
from app.services import credits as credits_service

logger = logging.getLogger("taskflow.workspace_storage")


def _as_aware_utc(dt: datetime) -> datetime:
    """Postgres round-trips tz-aware datetimes; SQLite drops tzinfo — normalize
    defensively so comparisons are correct on both backends (same helper as
    gpu_billing.py)."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def bill_workspace_storage(db: Session, workspace: Workspace) -> bool:
    """
    Catches up hourly billing for one ACTIVE workspace. Returns True when a
    charge was recorded. No-ops (keeping last_billed_at fresh so a later
    switch to hourly billing doesn't bill time already covered) for:
    - deleted workspaces,
    - prepaid workspaces (not metered hourly),
    - included-size workspaces (hourly_rate_micros == 0, never billed).
    """
    if workspace.status != WorkspaceStatus.ACTIVE:
        return False
    if workspace.billing_mode != StorageBillingMode.HOURLY:
        return False

    now = datetime.now(timezone.utc)
    if workspace.hourly_rate_micros <= 0 or workspace.last_billed_at is None:
        if workspace.last_billed_at is None:
            workspace.last_billed_at = now
            db.flush()
        return False

    elapsed_seconds = (now - _as_aware_utc(workspace.last_billed_at)).total_seconds()
    if elapsed_seconds <= 0:
        return False

    full_amount_micros = round(workspace.hourly_rate_micros * (elapsed_seconds / 3600.0))
    if full_amount_micros <= 0:
        workspace.last_billed_at = now
        db.flush()
        return False

    account = credits_service.get_or_create_account(db, workspace.organization_id)
    overdue = account.balance_micros < full_amount_micros
    amount_micros = min(full_amount_micros, max(account.balance_micros, 0))

    if amount_micros > 0:
        credits_service.record_transaction(
            db,
            organization_id=workspace.organization_id,
            type=CreditTransactionType.STORAGE_USAGE,
            amount_micros=-amount_micros,
            description=(
                f"Workspace storage — {workspace.name} "
                f"({workspace.storage_size_gb}GB, {elapsed_seconds:.0f}s)"
            ),
            allow_overdraft=False,
            workspace_id=workspace.id,
        )
        workspace.total_charged_micros += amount_micros

    workspace.payment_overdue_at = now if overdue else None
    workspace.last_billed_at = now
    db.flush()

    if overdue:
        logger.warning(
            "Workspace %s: wallet could not fully cover storage charge — flagged overdue, data preserved",
            workspace.id,
        )
    return amount_micros > 0


@dataclass
class StorageSweepResult:
    checked: int = 0
    billed: int = 0
    overdue_flagged: int = 0
    prepaid_reverted: int = 0


def run_storage_sweep(db: Session) -> StorageSweepResult:
    """
    The storage safety net — called by the same external cron as the GPU
    sweep (POST /internal/gpu/sweep). Bills every ACTIVE hourly workspace
    whether or not anybody is looking at the dashboard, and reverts expired
    prepaid commitments to hourly metering.
    """
    result = StorageSweepResult()
    now = datetime.now(timezone.utc)

    workspaces = list(
        db.execute(select(Workspace).where(Workspace.status == WorkspaceStatus.ACTIVE)).scalars()
    )
    for ws in workspaces:
        result.checked += 1

        if (
            ws.billing_mode == StorageBillingMode.PREPAID_30D
            and ws.prepaid_expires_at is not None
            and now > _as_aware_utc(ws.prepaid_expires_at)
        ):
            logger.info("Workspace %s: prepaid period expired — reverting to hourly billing", ws.id)
            ws.billing_mode = StorageBillingMode.HOURLY
            ws.prepaid_expires_at = None
            ws.last_billed_at = now  # hourly meter starts fresh at expiry
            result.prepaid_reverted += 1

        pre_overdue = ws.payment_overdue_at is not None
        if bill_workspace_storage(db, ws):
            result.billed += 1
        if not pre_overdue and ws.payment_overdue_at is not None:
            result.overdue_flagged += 1

    return result
