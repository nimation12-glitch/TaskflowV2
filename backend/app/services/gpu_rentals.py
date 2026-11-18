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
from app.models.workspace import WorkspaceStatus
from app.services import credits as credits_service
from app.services import scheduler
from app.services import ssh_keys as ssh_key_service

# Matches frontend/lib/compute-types.ts STORAGE_OPTIONS exactly.
ALLOWED_STORAGE_OPTIONS_GB = (50, 100, 250, 500)

# Matches frontend/lib/gpu-pricing.ts exactly — £0.03/hr per 100GB block
# beyond the included 100GB. amount is in micro-GBP.
INCLUDED_STORAGE_GB = 100
STORAGE_BLOCK_GB = 100
STORAGE_MICROS_PER_BLOCK = 30_000

# Multi-GPU rentals (rent N copies of the same SKU in one request). The cap
# matches the MAX plan's concurrent-rental ceiling, so even a full-cart MAX
# order fits inside a single plan's limits.
MAX_RENTALS_PER_REQUEST = 10

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


class WorkspaceNotFoundError(GpuRentalError):
    pass


class InvalidQuantityError(GpuRentalError):
    """quantity is outside 1..MAX_RENTALS_PER_REQUEST — a client bug, HTTP 400."""


class InvalidRentalStateError(GpuRentalError):
    pass


class ProvisioningFailedError(GpuRentalError):
    pass


class NoRegionAvailableError(GpuRentalError):
    """
    Spec §19: every supported region for this configuration is currently
    outside the safe-cost/AMI/availability thresholds. Surfaces as 503
    "temporarily unavailable" — never silently launch at a loss.
    """


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
    ssh_key_id: Optional[uuid.UUID],
    payment_mode: PaymentMode,
    booking_duration: Optional[BookingDuration],
    workspace_id: Optional[uuid.UUID] = None,
    location_preference: str = "automatic",
    quantity: int = 1,
) -> CreateRentalResult:
    plan = get_plan_for_org(db, organization_id)

    # Multi-GPU: N identical copies of the chosen SKU, created and billed as
    # one order. Every plan limit below is checked against the whole order.
    if not isinstance(quantity, int) or isinstance(quantity, bool) or not (1 <= quantity <= MAX_RENTALS_PER_REQUEST):
        raise InvalidQuantityError(f"quantity must be between 1 and {MAX_RENTALS_PER_REQUEST}")

    gpu_type = get_gpu_type_by_slug(db, gpu_type_slug)
    if gpu_type is None:
        raise GpuTierNotFoundError(f"GPU tier '{gpu_type_slug}' is not available")

    if storage_gb not in ALLOWED_STORAGE_OPTIONS_GB:
        raise StorageLimitExceededError(f"Storage size must be one of {ALLOWED_STORAGE_OPTIONS_GB}GB")
    if storage_gb > plan.gpu_max_storage_gb:
        raise StorageLimitExceededError(
            f"Your plan allows up to {plan.gpu_max_storage_gb}GB of storage per rental"
        )

    workspace = None
    if workspace_id is not None:
        from app.services import workspaces as workspace_service

        workspace = workspace_service.get_org_workspace(db, organization_id, workspace_id)
        if workspace is None:
            raise WorkspaceNotFoundError("Workspace not found")
        if workspace.status != WorkspaceStatus.ACTIVE:
            raise InvalidRentalStateError("Workspace is deleted")
        # Multiple active rentals may share one workspace — a workspace is a
        # persistent home directory, not a slot that locks (spec §22, as
        # revised for multi-GPU orders). Only deletion is guarded against
        # active rentals (workspaces.py delete path).

    ssh_key = (
        ssh_key_service.get_org_ssh_key(db, organization_id, ssh_key_id)
        if ssh_key_id is not None
        else None
    )
    if ssh_key is None and workspace is not None and workspace.ssh_key_id is not None:
        # A workspace carries its own persistent SSH identity (spec §5/§22) —
        # a rental attached to it inherits that key unless one is explicit.
        ssh_key = ssh_key_service.get_org_ssh_key(db, organization_id, workspace.ssh_key_id)
    if ssh_key is None:
        raise SshKeyNotFoundError("SSH key not found")

    active_rentals = count_concurrent_rentals(db, organization_id)
    if active_rentals + quantity > plan.gpu_max_concurrent_rentals:
        room = max(0, plan.gpu_max_concurrent_rentals - active_rentals)
        raise ConcurrentRentalLimitError(
            f"Your plan allows up to {plan.gpu_max_concurrent_rentals} concurrent GPU rental(s) and you already "
            f"run {active_rentals} — only {room} more can start. Reduce the quantity, stop or terminate an existing "
            "rental, or upgrade your plan."
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
    region_code: Optional[str] = None
    premium_micros = 0

    # Automatic region selection (spec §13). The (SKU x region) matrix seeded
    # by scripts/seed.py drives this; a SKU with no regional rows at all
    # (candidates is None) is legacy single-region data and keeps launching
    # via GpuType.aws_region/ami_id.
    candidates = scheduler.select_region_candidates(
        db,
        gpu_type,
        location_preference=location_preference,
        require_storage=workspace is not None,
    )
    if candidates is not None and not candidates:
        raise NoRegionAvailableError(
            "This GPU is temporarily unavailable in any supported region — try again shortly"
        )
    if candidates is not None:
        first = candidates[0]
        premium_micros = first.premium_micros
        hourly_rate_micros = scheduler.customer_hourly_rate_micros(
            gpu_type, plan, first.premium_micros, storage_gb
        )
        region_code = first.region_code

    if payment_mode == PaymentMode.PAY_AS_YOU_GO:
        account = credits_service.get_or_create_account(db, organization_id)
        # Minimum rental / wallet reserve (spec §20): every configuration
        # requires cover for at least its minimum rental before launch;
        # ULTRA-tier GPUs (A100/H100) require a stronger reserve. The reserve
        # covers the WHOLE order — N machines, not just the first one.
        reserve_micros = scheduler.reserve_amount_micros(gpu_type, hourly_rate_micros) * quantity
        if account.balance_micros < reserve_micros:
            hours = scheduler.reserve_hours_for(gpu_type)
            if hours > 1:
                raise InsufficientWalletBalanceError(
                    f"High-cost GPUs require your wallet to cover the first {hours} hours at this "
                    f"rate for {quantity} GPU{'' if quantity == 1 else 's'} — top up your wallet first"
                )
            raise InsufficientWalletBalanceError(
                "Your wallet balance won't cover even an hour at this rate — top up your wallet first"
            )

        from app.compute import aws_provider

        instances: list[GpuInstance] = []
        launched_ok: list[GpuInstance] = []
        last_error: Optional[Exception] = None
        try:
            for _ in range(quantity):
                instance = GpuInstance(
                    organization_id=organization_id,
                    created_by_user_id=user_id,
                    gpu_type_id=gpu_type.id,
                    ssh_key_id=ssh_key.id,
                    workspace_id=workspace.id if workspace is not None else None,
                    status=GpuInstanceStatus.PROVISIONING,
                    payment_mode=PaymentMode.PAY_AS_YOU_GO,
                    storage_gb=storage_gb,
                    hourly_rate_micros=hourly_rate_micros,
                    region_code=region_code,
                    regional_premium_micros=premium_micros,
                    provisioning_started_at=datetime.now(timezone.utc),
                    last_billed_at=datetime.now(timezone.utc),
                )
                db.add(instance)
                db.flush()
                instances.append(instance)

                if candidates is None:
                    # Legacy single-region path — no regional matrix for this SKU.
                    try:
                        aws_key_pair_name = ssh_key_service.ensure_aws_key_pair(db, ssh_key)
                        aws_instance_id, initial_state, availability_zone = aws_provider.launch_instance(
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
                    instance.availability_zone = availability_zone
                    db.flush()
                    launched_ok.append(instance)
                    continue

                # Multi-region launch loop (spec §13): walk the ordered candidates
                # until AWS accepts a launch. Capacity shortfalls and region-level
                # failures (unresolvable AMI, permissions...) fall back to the next
                # region — that is the §13/§19 fallback, not an error to hide.
                launched = False
                for candidate in candidates:
                    rate = scheduler.customer_hourly_rate_micros(
                        gpu_type, plan, candidate.premium_micros, storage_gb
                    )
                    # The machines still to come in this order must be coverable
                    # at this region's rate too, or the region is not affordable.
                    remaining = quantity - len(launched_ok)
                    if account.balance_micros < scheduler.reserve_amount_micros(gpu_type, rate) * remaining:
                        last_error = InsufficientWalletBalanceError(
                            f"Wallet cannot cover the {candidate.region_code} premium for {remaining} "
                            "GPU(s) — no affordable region left"
                        )
                        continue
                    try:
                        aws_key_pair_name = ssh_key_service.ensure_aws_key_pair(
                            db, ssh_key, region_name=candidate.region_code
                        )
                        aws_instance_id, initial_state, availability_zone = aws_provider.launch_instance(
                            gpu_type,
                            storage_gb,
                            aws_key_pair_name,
                            tags={
                                "Name": f"taskflow-{instance.id}",
                                "taskflow:gpu_instance_id": str(instance.id),
                                "taskflow:organization_id": str(organization_id),
                            },
                            region_name=candidate.region_code,
                            ami_id=candidate.ami_id,
                        )
                    except aws_provider.AwsNotConfiguredError as exc:
                        # A configuration problem fails identically in every region —
                        # no point walking the rest of the list.
                        last_error = exc
                        break
                    except aws_provider.AwsProviderError as exc:
                        last_error = exc
                        continue

                    instance.aws_instance_id = aws_instance_id
                    instance.region_code = candidate.region_code
                    instance.availability_zone = availability_zone
                    instance.regional_premium_micros = candidate.premium_micros
                    # The rate reflects the region actually launched in (§24) —
                    # fallback regions may carry a different premium than the first
                    # candidate the row was pre-created with.
                    instance.hourly_rate_micros = rate
                    db.flush()
                    launched = True
                    break

                if not launched:
                    instance.status = GpuInstanceStatus.FAILED
                    instance.error_detail = str(last_error)[:500] if last_error else "No region could host this launch"
                    db.flush()
                    raise ProvisioningFailedError(
                        str(last_error) if last_error else "No region could host this launch"
                    ) from last_error
                launched_ok.append(instance)
        except ProvisioningFailedError:
            # All-or-nothing for multi-GPU orders: the customer asked for N
            # machines as one order at one price — a partial launch (some
            # billing, some missing) is never acceptable. Best-effort tear
            # down anything already running, then surface the failure.
            for ok_instance in launched_ok:
                if ok_instance.aws_instance_id:
                    try:
                        aws_provider.terminate_instance(
                            ok_instance.aws_instance_id, region_name=ok_instance.region_code
                        )
                    except aws_provider.AwsProviderError:
                        pass  # orphan cleanup is retried by the billing sweep
                ok_instance.status = GpuInstanceStatus.TERMINATED
                ok_instance.terminated_at = datetime.now(timezone.utc)
                ok_instance.error_detail = "Order cancelled — not every GPU in the quantity could be provisioned"
            db.flush()
            raise

        return CreateRentalResult(instance=instances[0], checkout_url=None)

    # BOOKING mode: no AWS provisioning until Stripe confirms payment.
    # The region (and its premium, already inside hourly_rate_micros) is
    # selected NOW — the customer must know the final price before paying,
    # and the webhook launches into this exact region later. One PENDING_PAYMENT
    # row per GPU in the order; the Stripe line item carries quantity=N and the
    # webhook provisions all of them from gpu_instance_ids metadata.
    booking_instances: list[GpuInstance] = []
    for _ in range(quantity):
        instance = GpuInstance(
            organization_id=organization_id,
            created_by_user_id=user_id,
            gpu_type_id=gpu_type.id,
            ssh_key_id=ssh_key.id,
            workspace_id=workspace.id if workspace is not None else None,
            status=GpuInstanceStatus.PENDING_PAYMENT,
            payment_mode=PaymentMode.BOOKING,
            booking_duration=booking_duration,
            storage_gb=storage_gb,
            hourly_rate_micros=hourly_rate_micros,
            region_code=region_code,
            regional_premium_micros=premium_micros,
        )
        db.add(instance)
        booking_instances.append(instance)
    db.flush()

    hours = _BOOKING_HOURS[booking_duration]
    total_amount_micros = hourly_rate_micros * hours * quantity

    from app.billing import stripe_service

    checkout_url = stripe_service.create_gpu_booking_checkout_session(
        db, org, booking_instances, gpu_type, total_amount_micros
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

    aws_provider.stop_instance(instance.aws_instance_id, region_name=instance.region_code)
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
        aws_provider.start_instance(instance.aws_instance_id, region_name=instance.region_code)
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
        aws_provider.terminate_instance(instance.aws_instance_id, region_name=instance.region_code)

    instance.status = GpuInstanceStatus.TERMINATED
    instance.terminated_at = datetime.now(timezone.utc)
    db.flush()
    return instance
