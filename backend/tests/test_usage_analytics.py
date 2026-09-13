import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.billing import CreditTransaction, CreditTransactionType, Plan, PlanCode
from app.models.compute import GpuInstance, GpuInstanceStatus, GpuType, PaymentMode, SshKey
from app.models.org import Organization
from app.services import usage_analytics

PG_URL = "postgresql+psycopg2://postgres:postgres@localhost/taskflow_test"


@pytest.fixture()
def pg_session():
    engine = create_engine(PG_URL, future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, future=True)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


@pytest.fixture()
def org(pg_session):
    o = Organization(name="Analytics Test Org", slug=f"analytics-{uuid.uuid4().hex[:8]}")
    pg_session.add(o)
    pg_session.commit()
    return o


@pytest.fixture()
def starter_tier(pg_session):
    gt = GpuType(
        slug="starter", display_name="Starter", gpu_label="NVIDIA T4", aws_instance_type="g4dn.xlarge",
        aws_region="eu-west-2", ami_id="ami-test", vram_gb=16, vcpu=4, ram_gb=16,
        price_micros_per_hour=750_000, aws_cost_micros_per_hour=0, enabled=True,
    )
    pg_session.add(gt)
    pg_session.commit()
    return gt


@pytest.fixture()
def standard_tier(pg_session):
    gt = GpuType(
        slug="standard", display_name="Standard", gpu_label="NVIDIA A10G", aws_instance_type="g5.xlarge",
        aws_region="eu-west-2", ami_id="ami-test", vram_gb=24, vcpu=4, ram_gb=16,
        price_micros_per_hour=1_400_000, aws_cost_micros_per_hour=0, enabled=True,
    )
    pg_session.add(gt)
    pg_session.commit()
    return gt


@pytest.fixture()
def ssh_key(pg_session, org):
    k = SshKey(
        organization_id=org.id, created_by_user_id=uuid.uuid4(), label="test", public_key="ssh-ed25519 AAAA test",
        fingerprint="SHA256:test", created_at=datetime.now(timezone.utc),
    )
    pg_session.add(k)
    pg_session.commit()
    return k


def _make_instance(pg_session, org, ssh_key, gpu_type, hourly_rate_micros=750_000, total_charged_micros=0):
    inst = GpuInstance(
        organization_id=org.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id, ssh_key_id=ssh_key.id,
        status=GpuInstanceStatus.RUNNING, payment_mode=PaymentMode.PAY_AS_YOU_GO, storage_gb=50,
        hourly_rate_micros=hourly_rate_micros, total_charged_micros=total_charged_micros,
        aws_instance_id="i-test",
    )
    pg_session.add(inst)
    pg_session.commit()
    return inst


def _charge(pg_session, org, instance, amount_micros, created_at):
    """Records a GPU_USAGE debit directly (bypassing the lazy-billing machinery, which isn't under test here)."""
    txn = CreditTransaction(
        id=uuid.uuid4(), organization_id=org.id, type=CreditTransactionType.GPU_USAGE,
        amount_micros=-amount_micros, balance_after_micros=0, description="test charge",
        created_at=created_at, gpu_instance_id=instance.id,
    )
    pg_session.add(txn)
    instance.total_charged_micros += amount_micros
    pg_session.commit()
    return txn


# ---------- Empty state ----------

def test_empty_state_returns_all_zero_with_full_bucket_array(pg_session, org):
    result = usage_analytics.get_usage_summary(pg_session, org.id, "month")
    assert result["total_spend_micros"] == 0
    assert result["total_gpu_hours"] == 0
    assert result["most_used_gpu_type"] is None
    assert result["by_gpu_type"] == []
    assert len(result["spend_by_bucket"]) == 30
    assert all(b["spend_micros"] == 0 for b in result["spend_by_bucket"])


# ---------- Bucketing correctness per period ----------

def test_day_period_has_24_hourly_buckets_ending_at_current_hour(pg_session, org):
    now = datetime(2026, 9, 12, 14, 37, tzinfo=timezone.utc)
    result = usage_analytics.get_usage_summary(pg_session, org.id, "day", now=now)
    buckets = result["spend_by_bucket"]
    assert len(buckets) == 24
    assert buckets[0]["bucket_start"] == "2026-09-11T15:00:00Z"
    assert buckets[-1]["bucket_start"] == "2026-09-12T14:00:00Z"


def test_month_period_has_30_daily_buckets_ending_today(pg_session, org):
    now = datetime(2026, 9, 12, 14, 37, tzinfo=timezone.utc)
    result = usage_analytics.get_usage_summary(pg_session, org.id, "month", now=now)
    buckets = result["spend_by_bucket"]
    assert len(buckets) == 30
    assert buckets[0]["bucket_start"] == "2026-08-14T00:00:00Z"
    assert buckets[-1]["bucket_start"] == "2026-09-12T00:00:00Z"


def test_year_period_has_12_clean_calendar_months_not_rolling_window(pg_session, org):
    now = datetime(2026, 9, 12, 14, 37, tzinfo=timezone.utc)
    result = usage_analytics.get_usage_summary(pg_session, org.id, "year", now=now)
    buckets = result["spend_by_bucket"]
    assert len(buckets) == 12
    # 12 calendar months ending with the current month: Oct 2025 -> Sep 2026.
    assert buckets[0]["bucket_start"] == "2025-10-01T00:00:00Z"
    assert buckets[-1]["bucket_start"] == "2026-09-01T00:00:00Z"
    # No off-by-one: every bucket is the 1st of its month, in order.
    months = [b["bucket_start"][:7] for b in buckets]
    assert months == sorted(set(months)) and len(months) == len(set(months))


# ---------- most_used_gpu_type ranks by hours, not spend or recency ----------

def test_most_used_ranks_by_hours_not_spend(pg_session, org, ssh_key, starter_tier, standard_tier):
    now = datetime(2026, 9, 12, 12, 0, tzinfo=timezone.utc)
    within_window = now - timedelta(days=5)

    # Starter: cheap but rented for many hours -> highest hours.
    starter_instance = _make_instance(pg_session, org, ssh_key, starter_tier, hourly_rate_micros=750_000)
    _charge(pg_session, org, starter_instance, 750_000 * 10, within_window)  # 10 hours, 7.5M spend

    # Standard: expensive but rented briefly -> lower hours, but HIGHER spend.
    standard_instance = _make_instance(pg_session, org, ssh_key, standard_tier, hourly_rate_micros=1_400_000)
    _charge(pg_session, org, standard_instance, 1_400_000 * 6, within_window)  # 6 hours, 8.4M spend (more money, fewer hours)

    result = usage_analytics.get_usage_summary(pg_session, org.id, "month", now=now)

    assert result["most_used_gpu_type"]["slug"] == "starter"
    assert result["most_used_gpu_type"]["hours"] == 10.0
    by_slug = {t["slug"]: t for t in result["by_gpu_type"]}
    assert by_slug["standard"]["spend_micros"] == 8_400_000  # standard did spend more...
    assert by_slug["standard"]["hours"] == 6.0  # ...but fewer hours, so it's not "most used"
    assert result["total_spend_micros"] == 7_500_000 + 8_400_000
    assert result["total_gpu_hours"] == 16.0


# ---------- Tenant isolation ----------

def test_tenant_isolation(pg_session, ssh_key, starter_tier):
    org_a = Organization(name="Org A", slug=f"org-a-{uuid.uuid4().hex[:8]}")
    org_b = Organization(name="Org B", slug=f"org-b-{uuid.uuid4().hex[:8]}")
    pg_session.add_all([org_a, org_b])
    pg_session.commit()

    key_a = SshKey(
        organization_id=org_a.id, created_by_user_id=uuid.uuid4(), label="a", public_key="ssh-ed25519 AAAA a",
        fingerprint="SHA256:a", created_at=datetime.now(timezone.utc),
    )
    key_b = SshKey(
        organization_id=org_b.id, created_by_user_id=uuid.uuid4(), label="b", public_key="ssh-ed25519 AAAA b",
        fingerprint="SHA256:b", created_at=datetime.now(timezone.utc),
    )
    pg_session.add_all([key_a, key_b])
    pg_session.commit()

    now = datetime(2026, 9, 12, 12, 0, tzinfo=timezone.utc)
    within_window = now - timedelta(days=2)

    inst_a = _make_instance(pg_session, org_a, key_a, starter_tier)
    _charge(pg_session, org_a, inst_a, 750_000 * 4, within_window)

    inst_b = _make_instance(pg_session, org_b, key_b, starter_tier)
    _charge(pg_session, org_b, inst_b, 750_000 * 100, within_window)  # much bigger spend, different org

    result_a = usage_analytics.get_usage_summary(pg_session, org_a.id, "month", now=now)
    assert result_a["total_spend_micros"] == 3_000_000
    assert result_a["total_gpu_hours"] == 4.0

    result_b = usage_analytics.get_usage_summary(pg_session, org_b.id, "month", now=now)
    assert result_b["total_spend_micros"] == 75_000_000
    assert result_b["total_gpu_hours"] == 100.0


# ---------- Zero-activity buckets are present, not omitted ----------

def test_zero_activity_buckets_present_alongside_active_ones(pg_session, org, ssh_key, starter_tier):
    now = datetime(2026, 9, 12, 12, 0, tzinfo=timezone.utc)
    instance = _make_instance(pg_session, org, ssh_key, starter_tier)
    # Only one day in the 30-day window has any activity.
    _charge(pg_session, org, instance, 750_000 * 2, now - timedelta(days=10))

    result = usage_analytics.get_usage_summary(pg_session, org.id, "month", now=now)
    buckets = result["spend_by_bucket"]
    assert len(buckets) == 30  # every bucket present, none skipped

    nonzero = [b for b in buckets if b["spend_micros"] != 0]
    assert len(nonzero) == 1
    assert nonzero[0]["spend_micros"] == 1_500_000
    zero_buckets = [b for b in buckets if b["spend_micros"] == 0]
    assert len(zero_buckets) == 29


# ---------- Read-only guarantee ----------

def test_never_mutates_the_ledger(pg_session, org, ssh_key, starter_tier):
    instance = _make_instance(pg_session, org, ssh_key, starter_tier, total_charged_micros=5_000_000)
    _charge(pg_session, org, instance, 5_000_000, datetime.now(timezone.utc) - timedelta(days=1))

    before_count = pg_session.query(CreditTransaction).count()
    before_charged = instance.total_charged_micros

    usage_analytics.get_usage_summary(pg_session, org.id, "month")
    usage_analytics.get_usage_summary(pg_session, org.id, "day")
    usage_analytics.get_usage_summary(pg_session, org.id, "year")

    after_count = pg_session.query(CreditTransaction).count()
    pg_session.refresh(instance)
    assert after_count == before_count
    assert instance.total_charged_micros == before_charged


# ---------- HTTP-level: route wiring, query param default, auth ----------

def test_route_over_http_default_period_and_query_param(pg_session, org, ssh_key, starter_tier):
    import uuid as _uuid
    from fastapi.testclient import TestClient
    from jose import jwt
    from app.database import get_db

    now = datetime(2026, 9, 12, 12, 0, tzinfo=timezone.utc)
    instance = _make_instance(pg_session, org, ssh_key, starter_tier)
    _charge(pg_session, org, instance, 750_000 * 3, now - timedelta(days=1))

    import app.main as main_module
    main_module.app.dependency_overrides[get_db] = lambda: pg_session
    client = TestClient(main_module.app)
    try:
        token = jwt.encode(
            {"sub": str(_uuid.uuid4()), "org_id": str(org.id), "role": "OWNER"},
            "test-secret-test-secret-test-secret-32", algorithm="HS256",
        )
        headers = {"Authorization": f"Bearer {token}"}

        res = client.get("/compute/usage-summary", headers=headers)  # no ?period -> defaults to month
        assert res.status_code == 200
        assert res.json()["period"] == "month"
        assert len(res.json()["spend_by_bucket"]) == 30

        res = client.get("/compute/usage-summary?period=day", headers=headers)
        assert res.status_code == 200
        assert res.json()["period"] == "day"
        assert len(res.json()["spend_by_bucket"]) == 24

        res = client.get("/compute/usage-summary?period=nonsense", headers=headers)
        assert res.status_code == 422  # invalid literal rejected by FastAPI/Pydantic, not silently accepted
    finally:
        main_module.app.dependency_overrides.pop(get_db, None)
