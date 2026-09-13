"""
Lazy metering for GPU rentals — no persistent background worker assumed.
Any time a RUNNING pay-as-you-go rental is read (GET /compute/rentals or any
lifecycle action), bill_running_rental() catches up billing for elapsed time
since last_billed_at. refresh_provisioning_instance() additionally polls AWS
for PROVISIONING instances to detect RUNNING/FAILED transitions, since there
is no background worker to do that proactively either.

The safety sweep (POST /internal/gpu/sweep, see app/api/internal.py) is a
separate, coarser mechanism that catches rentals nobody is actively looking
at on a dashboard — this is the load-bearing safety net, not an optional
extra. See run_safety_sweep().
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.billing import CreditTransactionType
from app.models.compute import GpuInstance, GpuInstanceStatus, PaymentMode
from app.services import credits as credits_service

logger = logging.getLogger("taskflow.gpu_billing")


def _as_aware_utc(dt: datetime) -> datetime:
    """Postgres (DateTime(timezone=True)) always round-trips tz-aware datetimes,
    but SQLite (used in tests) silently drops tzinfo — normalize defensively
    so comparisons are correct on both backends. Matches app/services/invitations.py."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def bill_running_rental(db: Session, instance: GpuInstance) -> None:
    """
    Debits the wallet for elapsed time since last_billed_at on a RUNNING
    pay-as-you-go rental. No-ops for booking-mode rentals (already paid
    upfront) or anything not RUNNING. If the balance can't cover the full
    elapsed amount, charges exactly what's left and immediately auto-stops
    the instance rather than letting debt accumulate.
    """
    if instance.payment_mode != PaymentMode.PAY_AS_YOU_GO:
        return
    if instance.status != GpuInstanceStatus.RUNNING:
        return
    if instance.last_billed_at is None:
        instance.last_billed_at = datetime.now(timezone.utc)
        db.flush()
        return

    now = datetime.now(timezone.utc)
    elapsed_seconds = (now - _as_aware_utc(instance.last_billed_at)).total_seconds()
    if elapsed_seconds <= 0:
        return

    full_amount_micros = round(instance.hourly_rate_micros * (elapsed_seconds / 3600.0))
    if full_amount_micros <= 0:
        instance.last_billed_at = now
        db.flush()
        return

    account = credits_service.get_or_create_account(db, instance.organization_id)
    should_auto_stop = account.balance_micros < full_amount_micros
    amount_micros = min(full_amount_micros, max(account.balance_micros, 0))

    if amount_micros > 0:
        tier_label = instance.gpu_type.display_name if instance.gpu_type else str(instance.gpu_type_id)
        credits_service.record_transaction(
            db,
            organization_id=instance.organization_id,
            type=CreditTransactionType.GPU_USAGE,
            amount_micros=-amount_micros,
            description=f"GPU usage — {tier_label} ({elapsed_seconds:.0f}s)",
            allow_overdraft=False,
            gpu_instance_id=instance.id,
        )
        instance.total_charged_micros += amount_micros

    instance.last_billed_at = now
    db.flush()

    if should_auto_stop:
        logger.warning("Auto-stopping instance %s: wallet balance exhausted mid-session", instance.id)
        _force_stop(db, instance, reason="Wallet balance ran out")


def _force_stop(db: Session, instance: GpuInstance, *, reason: str) -> None:
    from app.compute import aws_provider

    try:
        if instance.aws_instance_id:
            aws_provider.stop_instance(instance.aws_instance_id)
    except aws_provider.AwsProviderError as exc:
        # Fail loudly in logs — an instance we believe should be stopped but
        # AWS rejected the stop call is exactly the "silently burn AWS spend"
        # scenario the safety sweep exists to prevent. Don't mark it STOPPED
        # if we don't actually know that's true.
        logger.error("Failed to auto-stop instance %s (%s): %s", instance.id, reason, exc)
        instance.error_detail = f"Auto-stop failed, needs manual attention: {exc}"[:500]
        db.flush()
        return

    instance.status = GpuInstanceStatus.STOPPED
    instance.stopped_at = datetime.now(timezone.utc)
    instance.error_detail = reason[:500]
    db.flush()


def _force_terminate(db: Session, instance: GpuInstance, *, reason: str) -> None:
    from app.compute import aws_provider

    try:
        if instance.aws_instance_id:
            aws_provider.terminate_instance(instance.aws_instance_id)
    except aws_provider.AwsProviderError as exc:
        logger.error("Failed to auto-terminate instance %s (%s): %s", instance.id, reason, exc)
        instance.error_detail = f"Auto-terminate failed, needs manual attention: {exc}"[:500]
        db.flush()
        return

    instance.status = GpuInstanceStatus.TERMINATED
    instance.terminated_at = datetime.now(timezone.utc)
    instance.error_detail = reason[:500]
    db.flush()


def refresh_provisioning_instance(db: Session, instance: GpuInstance) -> None:
    """
    Lazily checks AWS for a PROVISIONING instance's real state — flips to
    RUNNING (storing the public IP) once AWS confirms, or FAILED if it's been
    stuck past GPU_PROVISIONING_TIMEOUT_MINUTES. Called from GET
    /compute/rentals so users see accurate state without a background worker.
    """
    if instance.status != GpuInstanceStatus.PROVISIONING or not instance.aws_instance_id:
        return

    settings = get_settings()
    from app.compute import aws_provider

    try:
        status = aws_provider.get_instance_status(instance.aws_instance_id)
    except aws_provider.AwsProviderError as exc:
        logger.warning("Could not refresh status for instance %s: %s", instance.id, exc)
        return

    if status.state == "running":
        instance.status = GpuInstanceStatus.RUNNING
        instance.public_ip = status.public_ip
        instance.started_at = instance.started_at or datetime.now(timezone.utc)
        instance.last_billed_at = datetime.now(timezone.utc)
        db.flush()
        return

    if status.state in ("terminated", "shutting-down"):
        instance.status = GpuInstanceStatus.FAILED
        instance.error_detail = f"AWS instance unexpectedly entered state '{status.state}' during provisioning"[:500]
        db.flush()
        return

    if instance.provisioning_started_at:
        timeout = timedelta(minutes=settings.gpu_provisioning_timeout_minutes)
        if datetime.now(timezone.utc) - _as_aware_utc(instance.provisioning_started_at) > timeout:
            logger.error("Instance %s stuck in PROVISIONING past timeout — marking FAILED", instance.id)
            instance.status = GpuInstanceStatus.FAILED
            instance.error_detail = "Provisioning timed out — this indicates a real AWS-side problem, not hidden"
            db.flush()


def refresh_and_bill(db: Session, instance: GpuInstance) -> None:
    """Convenience combining both lazy checks — call from any endpoint that reads a single rental."""
    refresh_provisioning_instance(db, instance)
    bill_running_rental(db, instance)


@dataclass
class SweepResult:
    checked: int = 0
    billed: int = 0
    auto_stopped: int = 0
    auto_terminated: int = 0
    marked_failed: int = 0


def run_safety_sweep(db: Session) -> SweepResult:
    """
    The load-bearing safety mechanism. Must be called on a schedule (every
    2-5 minutes) by an external cron hitting POST /internal/gpu/sweep — see
    app/api/internal.py. Lazy, request-triggered billing only fires when
    someone actively loads a page; a forgotten rental with nobody checking
    the dashboard keeps running and accruing real AWS cost regardless.

    Runtime ceilings are enforced per payment mode, deliberately not mixed:
    GPU_MAX_RUNTIME_HOURS_DEFAULT / GpuType.max_runtime_hours / plan session
    caps apply only to PAY_AS_YOU_GO instances. A paid BOOKING is governed
    solely by its own booking_expires_at — applying the (much shorter)
    default runtime ceiling to a paid week-long booking would wrongly kill
    a rental the customer already paid for in full.
    """
    from app.services.gpu_rentals import get_plan_for_org

    settings = get_settings()
    result = SweepResult()
    now = datetime.now(timezone.utc)

    running = list(
        db.execute(select(GpuInstance).where(GpuInstance.status == GpuInstanceStatus.RUNNING)).scalars()
    )
    for instance in running:
        result.checked += 1
        pre_status = instance.status
        bill_running_rental(db, instance)
        if instance.status != pre_status:
            result.auto_stopped += 1
            continue
        result.billed += 1

        if instance.payment_mode == PaymentMode.PAY_AS_YOU_GO:
            gpu_type = instance.gpu_type
            cap_hours = (
                gpu_type.max_runtime_hours
                if gpu_type and gpu_type.max_runtime_hours
                else settings.gpu_max_runtime_hours_default
            )
            plan = get_plan_for_org(db, instance.organization_id)
            if plan.gpu_max_session_hours:
                cap_hours = min(cap_hours, plan.gpu_max_session_hours)
            if instance.started_at and now - _as_aware_utc(instance.started_at) > timedelta(hours=cap_hours):
                logger.warning("Instance %s exceeded max runtime (%sh) — auto-terminating", instance.id, cap_hours)
                _force_terminate(db, instance, reason=f"Exceeded maximum session length of {cap_hours}h")
                result.auto_terminated += 1
        elif instance.payment_mode == PaymentMode.BOOKING:
            if instance.booking_expires_at and now > _as_aware_utc(instance.booking_expires_at):
                logger.info("Booking %s expired — auto-terminating", instance.id)
                _force_terminate(db, instance, reason="Booking period expired")
                result.auto_terminated += 1

    provisioning = list(
        db.execute(select(GpuInstance).where(GpuInstance.status == GpuInstanceStatus.PROVISIONING)).scalars()
    )
    for instance in provisioning:
        result.checked += 1
        refresh_provisioning_instance(db, instance)
        if instance.status == GpuInstanceStatus.FAILED:
            result.marked_failed += 1

    return result
