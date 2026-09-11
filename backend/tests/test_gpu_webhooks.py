import uuid

from app.billing import stripe_service
from app.compute import aws_provider
from app.models.compute import BookingDuration, GpuInstance, GpuInstanceStatus, PaymentMode
from app.services import credits as credits_service


def _checkout_event(event_id: str, session: dict) -> dict:
    return {"id": event_id, "data": {"object": session}}


def test_wallet_topup_webhook_credits_ledger(db_session, organization):
    session = {
        "id": "cs_test_1",
        "customer": None,
        "payment_intent": "pi_test_1",
        "metadata": {
            "organization_id": str(organization.id),
            "purchase_type": "wallet_topup",
            "amount_micros": "25000000",
        },
    }
    stripe_service.handle_checkout_completed(db_session, _checkout_event("evt_topup_1", session))
    db_session.commit()

    account = credits_service.get_or_create_account(db_session, organization.id)
    assert account.balance_micros == 25_000_000


def test_gpu_booking_webhook_provisions_and_sets_expiry(db_session, organization, gpu_type, ssh_key, monkeypatch):
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.PENDING_PAYMENT, payment_mode=PaymentMode.BOOKING,
        booking_duration=BookingDuration.DAY, storage_gb=100, hourly_rate_micros=1_400_000,
    )
    db_session.add(instance)
    db_session.commit()

    monkeypatch.setattr(aws_provider, "import_ssh_key", lambda public_key, unique_name: unique_name)
    monkeypatch.setattr(aws_provider, "launch_instance", lambda *a, **k: ("i-booked-123", "pending"))

    session = {
        "id": "cs_test_2",
        "customer": "cus_test_2",
        "metadata": {
            "organization_id": str(organization.id),
            "purchase_type": "gpu_booking",
            "gpu_instance_id": str(instance.id),
        },
    }
    stripe_service.handle_checkout_completed(db_session, _checkout_event("evt_booking_1", session))
    db_session.commit()

    assert instance.status == GpuInstanceStatus.PROVISIONING
    assert instance.aws_instance_id == "i-booked-123"
    assert instance.booking_expires_at is not None


def test_gpu_booking_webhook_retry_does_not_double_provision(db_session, organization, gpu_type, ssh_key, monkeypatch):
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.PENDING_PAYMENT, payment_mode=PaymentMode.BOOKING,
        booking_duration=BookingDuration.WEEK, storage_gb=50, hourly_rate_micros=750_000,
    )
    db_session.add(instance)
    db_session.commit()

    launch_calls = []

    def _launch(*a, **k):
        launch_calls.append(1)
        return ("i-once-only", "pending")

    monkeypatch.setattr(aws_provider, "import_ssh_key", lambda public_key, unique_name: unique_name)
    monkeypatch.setattr(aws_provider, "launch_instance", _launch)

    session = {
        "id": "cs_test_3",
        "customer": "cus_test_3",
        "metadata": {
            "organization_id": str(organization.id),
            "purchase_type": "gpu_booking",
            "gpu_instance_id": str(instance.id),
        },
    }
    event = _checkout_event("evt_booking_2", session)

    stripe_service.handle_checkout_completed(db_session, event)
    db_session.commit()
    assert len(launch_calls) == 1
    assert instance.status == GpuInstanceStatus.PROVISIONING

    # Simulate Stripe retrying the same webhook event.
    stripe_service.handle_checkout_completed(db_session, event)
    db_session.commit()
    assert len(launch_calls) == 1  # never called a second time


def test_gpu_booking_webhook_marks_failed_if_aws_launch_fails_after_payment(db_session, organization, gpu_type, ssh_key, monkeypatch):
    instance = GpuInstance(
        organization_id=organization.id, created_by_user_id=uuid.uuid4(), gpu_type_id=gpu_type.id,
        ssh_key_id=ssh_key.id, status=GpuInstanceStatus.PENDING_PAYMENT, payment_mode=PaymentMode.BOOKING,
        booking_duration=BookingDuration.DAY, storage_gb=50, hourly_rate_micros=750_000,
    )
    db_session.add(instance)
    db_session.commit()

    monkeypatch.setattr(aws_provider, "import_ssh_key", lambda public_key, unique_name: unique_name)

    def _boom(*a, **k):
        raise aws_provider.AwsRequestError("simulated capacity error")

    monkeypatch.setattr(aws_provider, "launch_instance", _boom)

    session = {
        "id": "cs_test_4",
        "customer": None,
        "metadata": {
            "organization_id": str(organization.id),
            "purchase_type": "gpu_booking",
            "gpu_instance_id": str(instance.id),
        },
    }
    stripe_service.handle_checkout_completed(db_session, _checkout_event("evt_booking_3", session))
    db_session.commit()

    # Payment was captured by Stripe already — we never silently pretend the
    # booking succeeded, and this is flagged for manual refund review.
    assert instance.status == GpuInstanceStatus.FAILED
    assert "manual refund" in instance.error_detail
