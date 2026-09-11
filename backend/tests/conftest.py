import os
import uuid

os.environ.setdefault("AUTH_SECRET", "test-secret-test-secret-test-secret-32")
os.environ.setdefault("TASKFLOW_API_KEY_PEPPER", "test-pepper-test-pepper-test-pepper")
os.environ.setdefault("BACKEND_SERVICE_SECRET", "test-service-secret-test-service-secret")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401 registers all tables
from app.database import Base
from app.models.billing import Plan, PlanCode


@pytest.fixture()
def db_session():
    # StaticPool: a bare `sqlite:///:memory:` engine hands out a brand new,
    # empty in-memory database per connection — harmless for tests that stay
    # on one thread, but breaks as soon as TestClient runs a request in its
    # worker thread pool (a second connection sees "no such table"). StaticPool
    # keeps every checkout on the one shared connection regardless of thread,
    # which is the standard pattern for FastAPI + SQLite test fixtures.
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()

    # seed minimal plan data most tests need
    session.add_all(
        [
            Plan(
                code=PlanCode.FREE, display_name="Free", monthly_price_micros=0,
                monthly_credit_micros=2_000_000, rate_limit_rpm=20, compute_priority=0,
                max_members=3, allows_gpu_rental=True,
                gpu_max_concurrent_rentals=1, gpu_max_storage_gb=50, gpu_max_session_hours=4,
                gpu_booking_allowed=False, gpu_max_booking_days=0, gpu_rate_bps=10_000,
            ),
            Plan(
                code=PlanCode.PRO, display_name="Pro", monthly_price_micros=30_000_000,
                monthly_credit_micros=15_000_000, rate_limit_rpm=100, compute_priority=1,
                max_members=10, allows_gpu_rental=True,
                gpu_max_concurrent_rentals=3, gpu_max_storage_gb=250, gpu_max_session_hours=24 * 7,
                gpu_booking_allowed=True, gpu_max_booking_days=7, gpu_rate_bps=9_000,
            ),
            Plan(
                code=PlanCode.MAX, display_name="Max", monthly_price_micros=90_000_000,
                monthly_credit_micros=50_000_000, rate_limit_rpm=300, compute_priority=2,
                max_members=25, allows_gpu_rental=True,
                gpu_max_concurrent_rentals=10, gpu_max_storage_gb=500, gpu_max_session_hours=24 * 14,
                gpu_booking_allowed=True, gpu_max_booking_days=14, gpu_rate_bps=8_000,
            ),
        ]
    )
    session.commit()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def organization(db_session):
    from app.models.org import Organization

    org = Organization(name="Test Org", slug=f"test-org-{uuid.uuid4().hex[:8]}")
    db_session.add(org)
    db_session.commit()
    return org


@pytest.fixture()
def gpu_type(db_session):
    from app.models.compute import GpuType

    gt = GpuType(
        slug="standard",
        display_name="Standard",
        gpu_label="NVIDIA A10G",
        aws_instance_type="g5.xlarge",
        aws_region="eu-west-2",
        ami_id="ami-0123456789abcdef0",
        vram_gb=24,
        vcpu=4,
        ram_gb=16,
        price_micros_per_hour=1_400_000,
        aws_cost_micros_per_hour=0,
        enabled=True,
    )
    db_session.add(gt)
    db_session.commit()
    return gt


@pytest.fixture()
def ssh_public_key() -> str:
    from cryptography.hazmat.primitives.asymmetric import ed25519
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    key = ed25519.Ed25519PrivateKey.generate()
    pub_bytes = key.public_key().public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH)
    return pub_bytes.decode("ascii") + " test@taskflow"


@pytest.fixture()
def ssh_key(db_session, organization, ssh_public_key):
    from app.services import ssh_keys as ssh_key_service

    key = ssh_key_service.create_ssh_key(db_session, organization.id, uuid.uuid4(), "Test key", ssh_public_key)
    db_session.commit()
    return key
