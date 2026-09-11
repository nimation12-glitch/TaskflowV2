"""
Core GPU rental business logic. Route handlers (app/api/rentals.py) stay thin
and delegate here — mirrors the existing app/services/credits.py,
app/services/invitations.py pattern in this codebase.

Every plan limit is re-derived and re-checked here from the organization's
actual subscription, never trusted from the request body — the frontend's
greying-out of options is a UX nicety only (see docs comment in
frontend/lib/gpu-pricing.ts: "Keep these numbers in sync with the backend").
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.billing import Plan, PlanCode, Subscription
from app.models.compute import BookingDuration, GpuInstance, GpuInstanceStatus, GpuType, PaymentMode, SshKey
from app.models.org import Organization
from app.services import credits as credits_service
from app.services import ssh_keys as ssh_key_service

# Matches frontend/lib/compute-types.ts STORAGE_OPTIONS exactly.
ALLOWED_STORAGE_OPTIONS_GB = (50, 100, 250, 500)

# Matches frontend/lib/gpu-pricing.ts exactly — £0.03/hr per 100GB block
# beyond the included 100GB. amount is in micro-GBP.
INCLUDED_STORAGE_GB = 100
STORAGE_BLOCK_GB = 100
STORAGE_MICROS_PER_BLOCK = 30_000

_ACTIVE_STATUSES_FOR_CONCURRENCY = (
    GpuInstanceStatus.PROVISIONING,
    GpuInstanceStatus.RUNNING,
    GpuInstanceStatus.STOPPED,
)

_BOOKING_HOURS = {
    BookingDuration.DAY: 24,
    BookingDuration.WEEK: 24 * 7,
}


class GpuRentalError(Exception):
    """Base class for every rental-service error. Each maps to a specific HTTP status in app/api/rentals.py."""


class GpuTierNotFoundError(GpuRentalError):
    pass


class SshKeyNotFoundError(GpuRentalError):
    pass


class ConcurrentRentalLimitError(GpuRentalError):
    pass


class StorageLimitExceededError(GpuRentalError):
    pass


class BookingNotAllowedError(GpuRentalError):
    pass


class BookingDurationExceededError(GpuRentalError):
    pass


class InsufficientWalletBalanceError(GpuRentalError):
    pass


class RentalNotFoundError(GpuRentalError):
    pass


class InvalidRentalStateError(GpuRentalError):
    pass


class ProvisioningFailedError(GpuRentalError):
    pass


def get_plan_for_org(db: Session, organization_id: uuid.UUID) -> Plan:
    sub = db.execute(select(Subscription).where(Subscription.organization_id == organization_id)).scalar_one_or_none()
    if sub:
        plan = db.get(Plan, sub.plan_id)
        if plan:
            return plan
    # Every org is bootstrapped with a FREE subscription (see services/org.py);
    # this fallback only guards against a genuinely missing row and is
    # deliberately the most restrictive plan, never the most permissive.
    return db.execute(select(Plan).where(Plan.code == PlanCode.FREE)).scalar_one()


def list_enabled_gpu_types(db: Session) -> list[GpuType]:
    return list(db.execute(select(GpuType).where(GpuType.enabled == True).order_by(GpuType.price_micros_per_hour)).scalars())  # noqa: E712


def get_gpu_type_by_slug(db: Session, slug: str) -> GpuType | None:
    return db.execute(select(GpuType).where(GpuType.slug == slug, GpuType.enabled == True)).scalar_one_or_none()  # noqa: E712


def storage_add_on_micros(storage_gb: int) -> int:
    overage = max(0, storage_gb - INCLUDED_STORAGE_GB)
    if overage == 0:
        return 0
    blocks = -(-overage // STORAGE_BLOCK_GB)  # ceil division
    return blocks * STORAGE_MICROS_PER_BLOCK


def discounted_base_rate_micros(gpu_type: GpuType, plan: Plan) -> int:
    return (gpu_type.price_micros_per_hour * plan.gpu_rate_bps) // 10_000


def compute_hourly_rate_micros(gpu_type: GpuType, storage_gb: int, plan: Plan) -> int:
    return discounted_base_rate_micros(gpu_type, plan) + storage_add_on_micros(storage_gb)


def count_concurrent_rentals(db: Session, organization_id: uuid.UUID) -> int:
    return db.execute(
        select(GpuInstance.id).where(
            GpuInstance.organization_id == organization_id,
            GpuInstance.status.in_(_ACTIVE_STATUSES_FOR_CONCURRENCY),
        )
    ).all().__len__()


def get_org_rental(db: Session, organization_id: uuid.UUID, rental_id: uuid.UUID) -> GpuInstance | None:
    """Tenant-scoped lookup — every rental fetch in the API layer must go through this."""
    return db.execute(
        select(GpuInstance).where(GpuInstance.id == rental_id, GpuInstance.organization_id == organization_id)
    ).scalar_one_or_none()


def list_org_rentals(db: Session, organization_id: uuid.UUID) -> list[GpuInstance]:
    """
    Excludes PENDING_PAYMENT rows — the frontend's Rental/RentalStatus type
    has no representation for "created but not yet paid for", and nothing
    has actually been provisioned yet for those rows, so there is nothing
    the user needs to see or act on until the Stripe webhook confirms payment.
    """
    return list(
        db.execute(
            select(GpuInstance)
            .where(
                GpuInstance.organization_id == organization_id,
                GpuInstance.status != GpuInstanceStatus.PENDING_PAYMENT,
            )
            .order_by(GpuInstance.created_at.desc())
        ).scalars()
    )


@dataclass
class CreateRentalResult:
    instance: Optional[GpuInstance]
    checkout_url: Optional[str]


def create_rental(
    db: Session,
    *,
    organization_id: uuid.UUID,
    user_id: uuid.UUID,
    org: Organization,
    gpu_type_slug: str,
    storage_gb: int,
    ssh_key_id: uuid.UUID,
    payment_mode: PaymentMode,
    booking_duration: Optional[BookingDuration],
) -> CreateRentalResult:
    plan = get_plan_for_org(db, organization_id)

    gpu_type = get_gpu_type_by_slug(db, gpu_type_slug)
    if gpu_type is None:
        raise GpuTierNotFoundError(f"GPU tier '{gpu_type_slug}' is not available")

    if storage_gb not in ALLOWED_STORAGE_OPTIONS_GB:
        raise StorageLimitExceededError(f"Storage size must be one of {ALLOWED_STORAGE_OPTIONS_GB}GB")
    if storage_gb > plan.gpu_max_storage_gb:
        raise StorageLimitExceededError(
            f"Your plan allows up to {plan.gpu_max_storage_gb}GB of storage per rental"
        )

    ssh_key = ssh_key_service.get_org_ssh_key(db, organization_id, ssh_key_id)
    if ssh_key is None:
        raise SshKeyNotFoundError("SSH key not found")

    if count_concurrent_rentals(db, organization_id) >= plan.gpu_max_concurrent_rentals:
        raise ConcurrentRentalLimitError(
            f"Your plan allows up to {plan.gpu_max_concurrent_rentals} concurrent GPU rental(s). "
            "Stop or terminate an existing rental, or upgrade your plan."
        )

    if payment_mode == PaymentMode.BOOKING:
        if not plan.gpu_booking_allowed:
            raise BookingNotAllowedError("Your plan does not allow booking a GPU for a fixed period")
        if booking_duration is None:
            raise BookingDurationExceededError("booking_duration is required for booking mode")
        hours = _BOOKING_HOURS[booking_duration]
        if hours > plan.gpu_max_booking_days * 24:
            raise BookingDurationExceededError(
                f"Your plan allows booking for up to {plan.gpu_max_booking_days} day(s)"
            )

    hourly_rate_micros = compute_hourly_rate_micros(gpu_type, storage_gb, plan)

    if payment_mode == PaymentMode.PAY_AS_YOU_GO:
        account = credits_service.get_or_create_account(db, organization_id)
        if account.balance_micros < hourly_rate_micros:
            raise InsufficientWalletBalanceError(
                "Your wallet balance won't cover even an hour at this rate — top up your wallet first"
            )

        instance = GpuInstance(
            organization_id=organization_id,
            created_by_user_id=user_id,
            gpu_type_id=gpu_type.id,
            ssh_key_id=ssh_key.id,
            status=GpuInstanceStatus.PROVISIONING,
            payment_mode=PaymentMode.PAY_AS_YOU_GO,
            storage_gb=storage_gb,
            hourly_rate_micros=hourly_rate_micros,
            provisioning_started_at=datetime.now(timezone.utc),
            last_billed_at=datetime.now(timezone.utc),
        )
        db.add(instance)
        db.flush()

        from app.compute import aws_provider

        try:
            aws_key_pair_name = ssh_key_service.ensure_aws_key_pair(db, ssh_key)
            aws_instance_id, initial_state = aws_provider.launch_instance(
                gpu_type,
                storage_gb,
                aws_key_pair_name,
                tags={
                    "Name": f"taskflow-{instance.id}",
                    "taskflow:gpu_instance_id": str(instance.id),
                    "taskflow:organization_id": str(organization_id),
                },
            )
        except aws_provider.AwsProviderError as exc:
            instance.status = GpuInstanceStatus.FAILED
            instance.error_detail = str(exc)[:500]
            db.flush()
            raise ProvisioningFailedError(str(exc)) from exc

        instance.aws_instance_id = aws_instance_id
        db.flush()
        return CreateRentalResult(instance=instance, checkout_url=None)

    # BOOKING mode: no AWS provisioning until Stripe confirms payment.
    instance = GpuInstance(
        organization_id=organization_id,
        created_by_user_id=user_id,
        gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id,
        status=GpuInstanceStatus.PENDING_PAYMENT,
        payment_mode=PaymentMode.BOOKING,
        booking_duration=booking_duration,
        storage_gb=storage_gb,
        hourly_rate_micros=hourly_rate_micros,
    )
    db.add(instance)
    db.flush()

    hours = _BOOKING_HOURS[booking_duration]
    total_amount_micros = hourly_rate_micros * hours

    from app.billing import stripe_service

    checkout_url = stripe_service.create_gpu_booking_checkout_session(
        db, org, instance, gpu_type, total_amount_micros
    )
    return CreateRentalResult(instance=None, checkout_url=checkout_url)


def stop_rental(db: Session, organization_id: uuid.UUID, rental_id: uuid.UUID) -> GpuInstance:
    from app.services import gpu_billing

    instance = get_org_rental(db, organization_id, rental_id)
    if instance is None:
        raise RentalNotFoundError("Rental not found")
    if instance.payment_mode != PaymentMode.PAY_AS_YOU_GO:
        raise InvalidRentalStateError("Booking-mode rentals run for their full paid period and cannot be stopped early")
    if instance.status != GpuInstanceStatus.RUNNING:
        raise InvalidRentalStateError(f"Rental is {instance.status.value}, not RUNNING")

    gpu_billing.bill_running_rental(db, instance)

    from app.compute import aws_provider

    aws_provider.stop_instance(instance.aws_instance_id)
    # Optimistic: real EC2 "stopping" -> "stopped" transition happens asynchronously.
    # The sweep (app/services/gpu_billing.py::reconcile_instance_state) corrects this
    # if AWS later reports something else — never a silent lie, just an eventually-
    # consistent status shown a few seconds early.
    instance.status = GpuInstanceStatus.STOPPED
    instance.stopped_at = datetime.now(timezone.utc)
    db.flush()
    return instance


def start_rental(db: Session, organization_id: uuid.UUID, rental_id: uuid.UUID) -> GpuInstance:
    instance = get_org_rental(db, organization_id, rental_id)
    if instance is None:
        raise RentalNotFoundError("Rental not found")
    if instance.payment_mode != PaymentMode.PAY_AS_YOU_GO:
        raise InvalidRentalStateError("Booking-mode rentals cannot be manually restarted")
    if instance.status != GpuInstanceStatus.STOPPED:
        raise InvalidRentalStateError(f"Rental is {instance.status.value}, not STOPPED")

    account = credits_service.get_or_create_account(db, organization_id)
    if account.balance_micros < instance.hourly_rate_micros:
        raise InsufficientWalletBalanceError("Your wallet balance won't cover another hour at this rate")

    from app.compute import aws_provider

    try:
        aws_provider.start_instance(instance.aws_instance_id)
    except aws_provider.AwsInstanceStateError as exc:
        raise InvalidRentalStateError(
            "The instance is still finishing a previous transition in AWS — try again in a moment"
        ) from exc

    instance.status = GpuInstanceStatus.PROVISIONING
    instance.provisioning_started_at = datetime.now(timezone.utc)
    instance.last_billed_at = datetime.now(timezone.utc)
    db.flush()
    return instance


def terminate_rental(db: Session, organization_id: uuid.UUID, rental_id: uuid.UUID) -> GpuInstance:
    from app.services import gpu_billing

    instance = get_org_rental(db, organization_id, rental_id)
    if instance is None:
        raise RentalNotFoundError("Rental not found")
    if instance.status in (GpuInstanceStatus.TERMINATED, GpuInstanceStatus.TERMINATING):
        raise InvalidRentalStateError("Rental is already terminated or terminating")
    if instance.status == GpuInstanceStatus.PENDING_PAYMENT:
        # Never provisioned — nothing in AWS to tear down.
        instance.status = GpuInstanceStatus.TERMINATED
        instance.terminated_at = datetime.now(timezone.utc)
        db.flush()
        return instance

    if instance.payment_mode == PaymentMode.PAY_AS_YOU_GO and instance.status == GpuInstanceStatus.RUNNING:
        gpu_billing.bill_running_rental(db, instance)

    from app.compute import aws_provider

    if instance.aws_instance_id:
        aws_provider.terminate_instance(instance.aws_instance_id)

    instance.status = GpuInstanceStatus.TERMINATED
    instance.terminated_at = datetime.now(timezone.utc)
    db.flush()
    return instance
