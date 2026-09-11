import datetime
import uuid

from app.compute import aws_provider
from app.models.billing import CreditTransactionType
from app.models.compute import BookingDuration, GpuInstance, GpuInstanceStatus, PaymentMode
from app.services import credits as credits_service
from app.services import gpu_billing

NOW = datetime.datetime.now(datetime.timezone.utc)


def _fund_wallet(db_session, org_id, amount_micros):
    credits_service.record_transaction(
        db_session, organization_id=org_id, type=CreditTransactionType.PURCHASE,
        amount_micros=amount_micros, description="test funding",
    )


def test_sweep_auto_stops_when_balance_insufficient(db_session, organization, gpu_type, ssh_key, monkeypatch):
    _fund_wallet(db_session, organization.id, 500_000)  # covers half an hour at 1,000,000/hr
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.RUNNING, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=1_000_000, aws_instance_id="i-abc",
        started_at=NOW - datetime.timedelta(hours=1),
        last_billed_at=NOW - datetime.timedelta(hours=1),
    )
    db_session.add(instance)
    db_session.commit()

    stopped = []
    monkeypatch.setattr(aws_provider, "stop_instance", lambda iid: stopped.append(iid))

    result = gpu_billing.run_safety_sweep(db_session)

    assert stopped == ["i-abc"]
    assert instance.status == GpuInstanceStatus.STOPPED
    assert result.auto_stopped == 1
    account = credits_service.get_or_create_account(db_session, organization.id)
    assert account.balance_micros == 0  # charged exactly what was left, no debt


def test_sweep_auto_terminates_expired_booking(db_session, organization, gpu_type, ssh_key, monkeypatch):
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.RUNNING, payment_mode=PaymentMode.BOOKING,
        booking_duration=BookingDuration.DAY, storage_gb=50, hourly_rate_micros=750_000,
        aws_instance_id="i-booking", booking_expires_at=NOW - datetime.timedelta(minutes=5),
        started_at=NOW - datetime.timedelta(hours=25),
    )
    db_session.add(instance)
    db_session.commit()

    terminated = []
    monkeypatch.setattr(aws_provider, "terminate_instance", lambda iid: terminated.append(iid))

    result = gpu_billing.run_safety_sweep(db_session)

    assert terminated == ["i-booking"]
    assert instance.status == GpuInstanceStatus.TERMINATED
    assert result.auto_terminated == 1


def test_sweep_auto_terminates_payg_past_max_runtime(db_session, organization, gpu_type, ssh_key, monkeypatch):
    _fund_wallet(db_session, organization.id, 100_000_000)  # plenty of balance — this must be a runtime cap, not a balance issue
    gpu_type.max_runtime_hours = 48
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.RUNNING, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=750_000, aws_instance_id="i-longrun",
        started_at=NOW - datetime.timedelta(hours=49),
        last_billed_at=NOW - datetime.timedelta(minutes=1),
    )
    db_session.add(instance)
    db_session.commit()

    terminated = []
    monkeypatch.setattr(aws_provider, "terminate_instance", lambda iid: terminated.append(iid))

    result = gpu_billing.run_safety_sweep(db_session)

    assert terminated == ["i-longrun"]
    assert instance.status == GpuInstanceStatus.TERMINATED
    assert result.auto_terminated == 1


def test_sweep_does_not_kill_a_paid_booking_shorter_than_default_runtime_cap(db_session, organization, gpu_type, ssh_key, monkeypatch):
    """
    A paid week-long booking (168h) must not be killed by the much shorter
    GPU_MAX_RUNTIME_HOURS_DEFAULT (48h) — only PAY_AS_YOU_GO is subject to
    that ceiling. Booking mode is governed solely by booking_expires_at.
    """
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.RUNNING, payment_mode=PaymentMode.BOOKING,
        booking_duration=BookingDuration.WEEK, storage_gb=50, hourly_rate_micros=750_000,
        aws_instance_id="i-week-booking",
        started_at=NOW - datetime.timedelta(hours=72),  # past the 48h PAYG default, but booking isn't expired
        booking_expires_at=NOW + datetime.timedelta(hours=96),
    )
    db_session.add(instance)
    db_session.commit()

    terminate_called = []
    monkeypatch.setattr(aws_provider, "terminate_instance", lambda iid: terminate_called.append(iid))

    result = gpu_billing.run_safety_sweep(db_session)

    assert terminate_called == []
    assert instance.status == GpuInstanceStatus.RUNNING
    assert result.auto_terminated == 0


def test_sweep_marks_stuck_provisioning_as_failed(db_session, organization, gpu_type, ssh_key, monkeypatch):
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.PROVISIONING, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=750_000, aws_instance_id="i-stuck",
        provisioning_started_at=NOW - datetime.timedelta(minutes=30),
    )
    db_session.add(instance)
    db_session.commit()

    monkeypatch.setattr(
        aws_provider, "get_instance_status",
        lambda iid: aws_provider.InstanceStatus(state="pending", public_ip=None),
    )

    result = gpu_billing.run_safety_sweep(db_session)

    assert instance.status == GpuInstanceStatus.FAILED
    assert "timed out" in instance.error_detail
    assert result.marked_failed == 1


def test_sweep_flips_provisioning_to_running_once_aws_confirms(db_session, organization, gpu_type, ssh_key, monkeypatch):
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.PROVISIONING, payment_mode=PaymentMode.PAY_AS_YOU_GO,
        storage_gb=50, hourly_rate_micros=750_000, aws_instance_id="i-ready",
        provisioning_started_at=NOW - datetime.timedelta(minutes=2),
    )
    db_session.add(instance)
    db_session.commit()

    monkeypatch.setattr(
        aws_provider, "get_instance_status",
        lambda iid: aws_provider.InstanceStatus(state="running", public_ip="1.2.3.4"),
    )

    gpu_billing.run_safety_sweep(db_session)

    assert instance.status == GpuInstanceStatus.RUNNING
    assert instance.public_ip == "1.2.3.4"
