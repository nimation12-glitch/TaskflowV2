"""
Phase 3: regions, the (SKU x region) premium matrix, the scheduler, and
regional AMI resolution (spec §12-§15, §19-§20, §24).

Service-level coverage (the API layer is thin mapping):
- candidate filters: location preference, NOT_OFFERED ("N/A"), disabled
  regions, safe-cost threshold, storage/SSH support flags
- premium pricing: premium added to the discounted base, never plan-discounted
- §20 wallet reserves: minimum rental hours, stronger reserve for ULTRA tier
- §13 fallback: InsufficientInstanceCapacity -> next candidate region, with
  the rate re-snapshotted to the region actually launched in
- legacy fallback: a SKU with no regional matrix keeps the old single-region
  launch path
- AMI resolver: SSM resolution cached on the availability row with a TTL
- §14 startup estimates: measured p50 drives candidate ordering
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.compute import ami_resolver
from app.compute import aws_provider
from app.models.billing import (
    CreditTransactionType,
    Plan,
    PlanCode,
    Subscription,
    SubscriptionStatus,
)
from app.models.compute import (
    BookingDuration,
    GpuInstance,
    GpuInstanceStatus,
    GpuTier,
    PaymentMode,
)
from app.models.org import Organization
from app.models.region import (
    GpuRegionAvailability,
    GpuRegionStatus,
    Region,
    RegionStatus,
)
from app.services import credits as credits_service
from app.services import gpu_rentals
from app.services import scheduler


@pytest.fixture(autouse=True)
def no_real_aws(monkeypatch):
    """Every test here must be able to run with zero network access."""
    monkeypatch.setattr(
        ami_resolver, "resolve_ami_from_ssm", lambda region_name: f"ami-{region_name}-resolved"
    )
    monkeypatch.setattr(
        aws_provider, "import_ssh_key", lambda public_key, unique_name, region_name=None: unique_name
    )


def _top_up(db, organization_id, amount_micros):
    credits_service.record_transaction(
        db,
        organization_id=organization_id,
        type=CreditTransactionType.PURCHASE,
        amount_micros=amount_micros,
        description="test top-up",
    )


def _region(db, code, area="Europe", *, status=RegionStatus.AVAILABLE, storage=True, ssh=True):
    region = Region(
        aws_region_code=code,
        public_name=code,
        country_or_area=area,
        status=status,
        storage_support=storage,
        ssh_support=ssh,
    )
    db.add(region)
    db.flush()
    return region


def _availability(db, gpu_type, region, *, premium=0, status=GpuRegionStatus.AVAILABLE, cost_est=None, ami=None):
    row = GpuRegionAvailability(
        gpu_type_id=gpu_type.id,
        region_id=region.id,
        status=status,
        premium_micros=premium,
        # Seed convention: regional cost estimate = baseline cost (0 for the
        # test fixture) + premium. Tests override it to exercise safe-cost.
        aws_cost_est_micros_per_hour=(premium if cost_est is None else cost_est),
        ami_id=ami,
    )
    db.add(row)
    db.flush()
    return row


def _pro_org(db, organization):
    plan = db.execute(select(Plan).where(Plan.code == PlanCode.PRO)).scalar_one()
    db.add(Subscription(organization_id=organization.id, plan_id=plan.id, status=SubscriptionStatus.ACTIVE))
    db.commit()
    return organization


def _create(db, org, gpu_type, ssh_key, *, location="automatic", payment_mode=PaymentMode.PAY_AS_YOU_GO):
    return gpu_rentals.create_rental(
        db,
        organization_id=org.id,
        user_id=uuid.uuid4(),
        org=org,
        gpu_type_slug=gpu_type.slug,
        storage_gb=50,
        ssh_key_id=ssh_key.id,
        payment_mode=payment_mode,
        booking_duration=None,
        location_preference=location,
    )


def _launch_stub(calls: list, fail_regions: set | None = None):
    """Records launch kwargs; raises the EC2 capacity error for listed regions."""

    def _launch(gpu_type, storage_gb, key_name, tags, *, region_name=None, ami_id=None, availability_zone=None):
        calls.append({"region": region_name, "ami": ami_id, "az": availability_zone})
        if fail_regions and region_name in fail_regions:
            raise aws_provider.AwsInsufficientCapacityError(
                "InsufficientInstanceCapacity", aws_error_code="InsufficientInstanceCapacity"
            )
        return f"i-{region_name or 'legacy'}", "pending", f"{region_name or 'us-east-1'}a"

    return _launch


# ---------------------------------------------------------------- candidate filters


def test_location_preference_filters_candidates(db_session, organization, gpu_type, ssh_key):
    us = _region(db_session, "us-east-1", area="North America")
    uk = _region(db_session, "eu-west-2", area="UK")
    eu = _region(db_session, "eu-north-1", area="Europe")
    for r in (us, uk, eu):
        _availability(db_session, gpu_type, r, premium=100_000)

    automatic = scheduler.select_region_candidates(db_session, gpu_type)
    assert [c.region_code for c in automatic] == ["eu-north-1", "eu-west-2", "us-east-1"]  # premium tie -> region code

    uk_only = scheduler.select_region_candidates(db_session, gpu_type, location_preference="uk")
    assert [c.region_code for c in uk_only] == ["eu-west-2"]

    na_only = scheduler.select_region_candidates(db_session, gpu_type, location_preference="north_america")
    assert [c.region_code for c in na_only] == ["us-east-1"]


def test_not_offered_and_disabled_excluded(db_session, organization, gpu_type):
    ok = _region(db_session, "us-east-1", area="North America")
    na_row = _region(db_session, "eu-west-2", area="UK")
    off = _region(db_session, "eu-central-1", area="Europe")
    _availability(db_session, gpu_type, ok, premium=0)
    _availability(db_session, gpu_type, na_row, premium=100_000, status=GpuRegionStatus.NOT_OFFERED)
    _availability(db_session, gpu_type, off, premium=100_000)

    off.status = RegionStatus.DISABLED
    db_session.commit()

    candidates = scheduler.select_region_candidates(db_session, gpu_type)
    assert [c.region_code for c in candidates] == ["us-east-1"]


def test_safe_cost_threshold_excludes_region(db_session, organization, gpu_type):
    # gpu_type.safe_infrastructure_cost_micros defaults to 0 in the fixture.
    safe = _region(db_session, "us-east-1", area="North America")
    unsafe = _region(db_session, "eu-west-2", area="UK")
    _availability(db_session, gpu_type, safe, premium=0, cost_est=0)
    # One micro over the ceiling (0 + premium) -> unsafe (§19).
    _availability(db_session, gpu_type, unsafe, premium=100_000, cost_est=100_001)

    candidates = scheduler.select_region_candidates(db_session, gpu_type)
    assert [c.region_code for c in candidates] == ["us-east-1"]


def test_storage_support_flag_required_for_workspace_rentals(db_session, organization, gpu_type):
    no_storage = _region(db_session, "us-east-1", area="North America", storage=False)
    good = _region(db_session, "eu-north-1", area="Europe")
    _availability(db_session, gpu_type, no_storage, premium=0)
    _availability(db_session, gpu_type, good, premium=100_000)

    with_storage = scheduler.select_region_candidates(db_session, gpu_type, require_storage=True)
    assert [c.region_code for c in with_storage] == ["eu-north-1"]

    without = scheduler.select_region_candidates(db_session, gpu_type)
    # Startup defaults equal (no measured data) -> premium ascending.
    assert [c.region_code for c in without] == ["us-east-1", "eu-north-1"]


def test_no_matrix_at_all_is_legacy(db_session, organization, gpu_type):
    assert scheduler.select_region_candidates(db_session, gpu_type) is None


def test_matrix_present_but_nothing_viable(db_session, organization, gpu_type):
    r = _region(db_session, "eu-west-2", area="UK")
    _availability(db_session, gpu_type, r, status=GpuRegionStatus.NOT_OFFERED)
    assert scheduler.select_region_candidates(db_session, gpu_type) == []


# ---------------------------------------------------------------- pricing


def test_premium_snapshot_in_rate_and_launch(db_session, organization, gpu_type, ssh_key, monkeypatch):
    uk = _region(db_session, "eu-west-2", area="UK")
    _availability(db_session, gpu_type, uk, premium=200_000)
    _top_up(db_session, organization.id, 10_000_000)

    calls: list = []
    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub(calls))

    result = _create(db_session, organization, gpu_type, ssh_key, location="uk")

    instance = result.instance
    assert instance.region_code == "eu-west-2"
    assert instance.regional_premium_micros == 200_000
    # FREE plan: no discount; base 1_400_000 + premium 200_000 + 50GB storage (0) = 1_600_000.
    assert instance.hourly_rate_micros == 1_600_000
    assert instance.availability_zone == "eu-west-2a"
    assert calls == [{"region": "eu-west-2", "ami": "ami-eu-west-2-resolved", "az": None}]


def test_premium_is_never_plan_discounted(db_session, organization, gpu_type, ssh_key, monkeypatch):
    _pro_org(db_session, organization)
    us = _region(db_session, "us-east-1", area="North America")
    _availability(db_session, gpu_type, us, premium=200_000)
    _top_up(db_session, organization.id, 10_000_000)

    calls: list = []
    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub(calls))

    result = _create(db_session, organization, gpu_type, ssh_key)
    # PRO rate_bps=9000 -> base 1_260_000. The premium is NOT discounted (§24).
    assert result.instance.hourly_rate_micros == 1_260_000 + 200_000


def test_ultra_tier_requires_stronger_wallet_reserve(db_session, organization, ssh_key, monkeypatch):
    from app.models.compute import GpuType

    ultra = GpuType(
        slug="h100-nano",
        display_name="H100 Nano",
        gpu_label="NVIDIA H100",
        tier=GpuTier.ULTRA,
        aws_instance_type="p5.4xlarge",
        aws_region="us-east-1",
        ami_id="ami-0123456789abcdef0",
        vram_gb=80,
        vcpu=16,
        ram_gb=256,
        price_micros_per_hour=15_230_000,
        aws_cost_micros_per_hour=0,
        safe_infrastructure_cost_micros=0,
        minimum_rental_hours=1,
        enabled=True,
    )
    db_session.add(ultra)
    db_session.commit()

    us = _region(db_session, "us-east-1", area="North America")
    _availability(db_session, ultra, us, premium=0)

    calls: list = []
    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub(calls))

    # Only 2 hours of cover: below the §20 ULTRA reserve (4 hours).
    _top_up(db_session, organization.id, ultra.price_micros_per_hour * 2)
    with pytest.raises(gpu_rentals.InsufficientWalletBalanceError) as excinfo:
        _create(db_session, organization, ultra, ssh_key)
    assert "4 hours" in str(excinfo.value)

    # 4 hours of cover: accepted.
    _top_up(db_session, organization.id, ultra.price_micros_per_hour * 2)
    result = _create(db_session, organization, ultra, ssh_key)
    assert result.instance.status == GpuInstanceStatus.PROVISIONING


# ---------------------------------------------------------------- launch fallback


def test_capacity_error_falls_back_to_next_region(db_session, organization, gpu_type, ssh_key, monkeypatch):
    us = _region(db_session, "us-east-1", area="North America")  # premium 0 -> ordered first
    uk = _region(db_session, "eu-west-2", area="UK")  # premium 200_000 -> second
    _availability(db_session, gpu_type, us, premium=0)
    _availability(db_session, gpu_type, uk, premium=200_000)
    _top_up(db_session, organization.id, 10_000_000)

    calls: list = []
    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub(calls, fail_regions={"us-east-1"}))

    result = _create(db_session, organization, gpu_type, ssh_key)

    assert [c["region"] for c in calls] == ["us-east-1", "eu-west-2"]
    instance = result.instance
    # The rental reflects the region actually launched in (§24).
    assert instance.region_code == "eu-west-2"
    assert instance.regional_premium_micros == 200_000
    assert instance.hourly_rate_micros == 1_400_000 + 200_000
    assert instance.aws_instance_id == "i-eu-west-2"


def test_all_regions_at_capacity_marks_failed(db_session, organization, gpu_type, ssh_key, monkeypatch):
    us = _region(db_session, "us-east-1", area="North America")
    uk = _region(db_session, "eu-west-2", area="UK")
    _availability(db_session, gpu_type, us, premium=0)
    _availability(db_session, gpu_type, uk, premium=200_000)
    _top_up(db_session, organization.id, 10_000_000)

    calls: list = []
    monkeypatch.setattr(
        aws_provider, "launch_instance", _launch_stub(calls, fail_regions={"us-east-1", "eu-west-2"})
    )

    with pytest.raises(gpu_rentals.ProvisioningFailedError):
        _create(db_session, organization, gpu_type, ssh_key)

    rentals = gpu_rentals.list_org_rentals(db_session, organization.id)
    assert len(rentals) == 1
    assert rentals[0].status == GpuInstanceStatus.FAILED
    assert "InsufficientInstanceCapacity" in rentals[0].error_detail


def test_no_viable_region_surfaces_temporarily_unavailable(db_session, organization, gpu_type, ssh_key):
    r = _region(db_session, "eu-west-2", area="UK")
    _availability(db_session, gpu_type, r, status=GpuRegionStatus.NOT_OFFERED)
    _top_up(db_session, organization.id, 10_000_000)

    with pytest.raises(gpu_rentals.NoRegionAvailableError):
        _create(db_session, organization, gpu_type, ssh_key)


def test_ami_resolution_failure_skips_region(db_session, organization, gpu_type, ssh_key, monkeypatch):
    good = _region(db_session, "us-east-1", area="North America")
    broken = _region(db_session, "eu-west-2", area="UK")
    _availability(db_session, gpu_type, good, premium=0)
    _availability(db_session, gpu_type, broken, premium=100_000)

    real_resolve = ami_resolver.resolve_ami_from_ssm

    def flaky(region_name):
        if region_name == "eu-west-2":
            raise ami_resolver.AmiResolutionError("SSM denied")
        return real_resolve(region_name)

    monkeypatch.setattr(ami_resolver, "resolve_ami_from_ssm", flaky)
    candidates = scheduler.select_region_candidates(db_session, gpu_type)
    assert [c.region_code for c in candidates] == ["us-east-1"]


def test_legacy_sku_without_matrix_uses_configured_region(db_session, organization, gpu_type, ssh_key, monkeypatch):
    # gpu_type has NO availability rows -> legacy single-region path.
    _top_up(db_session, organization.id, 10_000_000)
    calls: list = []
    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub(calls))

    result = _create(db_session, organization, gpu_type, ssh_key)

    assert calls[0]["region"] is None  # provider falls back to settings.aws_region
    assert calls[0]["ami"] is None  # provider falls back to gpu_type.ami_id
    instance = result.instance
    assert instance.region_code is None
    assert instance.regional_premium_micros == 0
    assert instance.hourly_rate_micros == 1_400_000  # no premium anywhere


def test_booking_mode_quotes_region_and_premium_upfront(db_session, organization, gpu_type, ssh_key, monkeypatch):
    from app.billing import stripe_service

    # The checkout session itself needs real Stripe (nothing simulates billing);
    # this test covers the region/premium quoting, so stub the checkout step.
    monkeypatch.setattr(
        stripe_service,
        "create_gpu_booking_checkout_session",
        lambda db, org, instance, gpu_type, total_amount_micros: "https://checkout.stripe.test/session",
    )
    _pro_org(db_session, organization)
    uk = _region(db_session, "eu-west-2", area="UK")
    _availability(db_session, gpu_type, uk, premium=300_000)

    result = gpu_rentals.create_rental(
        db_session,
        organization_id=organization.id,
        user_id=uuid.uuid4(),
        org=organization,
        gpu_type_slug=gpu_type.slug,
        storage_gb=50,
        ssh_key_id=ssh_key.id,
        payment_mode=PaymentMode.BOOKING,
        booking_duration=BookingDuration.DAY,
        location_preference="uk",
    )
    assert result.instance is None  # provisioned by the webhook after payment
    row = db_session.execute(
        select(GpuInstance).where(GpuInstance.organization_id == organization.id)
    ).scalar_one()
    assert row.status == GpuInstanceStatus.PENDING_PAYMENT
    assert row.region_code == "eu-west-2"
    assert row.regional_premium_micros == 300_000
    # 24h × (1_260_000 base + 300_000 premium)
    assert row.hourly_rate_micros == 1_560_000


# ---------------------------------------------------------------- startup estimates


def test_measured_startup_p50_orders_candidates(db_session, organization, ssh_key):
    from app.models.compute import GpuType

    sku = GpuType(
        slug="l4-medium", display_name="L4 Medium", gpu_label="NVIDIA L4",
        aws_instance_type="g6.4xlarge", aws_region="eu-north-1",
        ami_id="ami-0123456789abcdef0", vram_gb=24, vcpu=16, ram_gb=64,
        price_micros_per_hour=2_930_000, aws_cost_micros_per_hour=0,
        safe_infrastructure_cost_micros=0, enabled=True,
    )
    db_session.add(sku)
    db_session.commit()

    fast = _region(db_session, "eu-north-1", area="Europe")   # measured fast, pricier
    slow = _region(db_session, "us-west-2", area="North America")  # measured slow, cheaper
    _availability(db_session, sku, fast, premium=500_000)
    _availability(db_session, sku, slow, premium=0)

    now = datetime.now(timezone.utc)
    for delta_seconds in (25, 30, 35):  # three samples -> p50 = 30s
        db_session.add(
            GpuInstance(
                organization_id=organization.id,
                created_by_user_id=uuid.uuid4(),
                gpu_type_id=sku.id,
                ssh_key_id=ssh_key.id,
                status=GpuInstanceStatus.TERMINATED,
                payment_mode=PaymentMode.PAY_AS_YOU_GO,
                storage_gb=50,
                hourly_rate_micros=1,
                region_code="eu-north-1",
                provisioning_started_at=now - timedelta(hours=1),
                started_at=now - timedelta(hours=1) + timedelta(seconds=delta_seconds),
                terminated_at=now,
            )
        )
    db_session.add(
        GpuInstance(
            organization_id=organization.id,
            created_by_user_id=uuid.uuid4(),
            gpu_type_id=sku.id,
            ssh_key_id=ssh_key.id,
            status=GpuInstanceStatus.TERMINATED,
            payment_mode=PaymentMode.PAY_AS_YOU_GO,
            storage_gb=50,
            hourly_rate_micros=1,
            region_code="us-west-2",
            provisioning_started_at=now - timedelta(hours=1),
            started_at=now - timedelta(hours=1) + timedelta(seconds=300),
            terminated_at=now,
        )
    )
    db_session.commit()

    candidates = scheduler.select_region_candidates(db_session, sku)
    # §13: acceptable startup time is prioritised over infrastructure economics.
    assert [c.region_code for c in candidates] == ["eu-north-1", "us-west-2"]
    assert candidates[0].startup_estimate_seconds == 30.0
    assert candidates[1].startup_estimate_seconds == 300.0


# ---------------------------------------------------------------- AMI resolver


def test_ami_resolved_once_then_cached(db_session, organization, gpu_type):
    us = _region(db_session, "us-east-1", area="North America")
    row = _availability(db_session, gpu_type, us, premium=0)

    calls: list = []

    def counting_resolve(region_name):
        calls.append(region_name)
        return f"ami-{region_name}-resolved"

    monkey_target = ami_resolver
    original = monkey_target.resolve_ami_from_ssm
    monkey_target.resolve_ami_from_ssm = counting_resolve
    try:
        first = ami_resolver.get_or_resolve_ami(db_session, row)
        second = ami_resolver.get_or_resolve_ami(db_session, row)
    finally:
        monkey_target.resolve_ami_from_ssm = original

    assert first == second == "ami-us-east-1-resolved"
    assert calls == ["us-east-1"]  # cached: one real SSM resolution
    assert row.ami_id == "ami-us-east-1-resolved"
    assert row.ami_resolved_at is not None


def test_ami_cache_expires_and_re_resolves(db_session, organization, gpu_type):
    us = _region(db_session, "us-east-1", area="North America")
    row = _availability(db_session, gpu_type, us, premium=0)
    row.ami_id = "ami-stale"
    row.ami_resolved_at = datetime.now(timezone.utc) - timedelta(hours=25)
    db_session.commit()

    ami = ami_resolver.get_or_resolve_ami(db_session, row)
    assert ami == "ami-us-east-1-resolved"  # stale cache ignored, re-resolved


def test_ami_cache_six_hours_still_fresh(db_session, organization, gpu_type):
    us = _region(db_session, "us-east-1", area="North America")
    row = _availability(db_session, gpu_type, us, premium=0)
    row.ami_id = "ami-fresh"
    row.ami_resolved_at = datetime.now(timezone.utc) - timedelta(hours=6)
    db_session.commit()

    calls: list = []

    def counting(region_name):
        calls.append(region_name)
        return "ami-new"

    original = ami_resolver.resolve_ami_from_ssm
    ami_resolver.resolve_ami_from_ssm = counting
    try:
        ami = ami_resolver.get_or_resolve_ami(db_session, row)
    finally:
        ami_resolver.resolve_ami_from_ssm = original

    assert ami == "ami-fresh"
    assert calls == []
