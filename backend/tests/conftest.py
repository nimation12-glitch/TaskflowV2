import os
import uuid

os.environ.setdefault("AUTH_SECRET", "test-secret-test-secret-test-secret-32")
os.environ.setdefault("TASKFLOW_API_KEY_PEPPER", "test-pepper-test-pepper-test-pepper")
os.environ.setdefault("BACKEND_SERVICE_SECRET", "test-service-secret-test-service-secret")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.models  # noqa: F401 registers all tables
from app.database import Base
from app.models.billing import Plan, PlanCode


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()

    # seed minimal plan data most tests need
    session.add_all(
        [
            Plan(
                code=PlanCode.FREE, display_name="Free", monthly_price_micros=0,
                monthly_credit_micros=2_000_000, rate_limit_rpm=20, compute_priority=0,
                max_members=3, allows_gpu_rental=False,
            ),
            Plan(
                code=PlanCode.PRO, display_name="Pro", monthly_price_micros=30_000_000,
                monthly_credit_micros=15_000_000, rate_limit_rpm=100, compute_priority=1,
                max_members=10, allows_gpu_rental=True,
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
