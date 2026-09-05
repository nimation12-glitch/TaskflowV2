import pytest

from app.models.billing import CreditTransactionType
from app.services import credits as credits_service


def test_grant_increases_balance(db_session, organization):
    txn = credits_service.record_transaction(
        db_session,
        organization_id=organization.id,
        type=CreditTransactionType.MONTHLY_GRANT,
        amount_micros=15_000_000,
        description="Monthly Pro allowance",
    )
    assert txn.balance_after_micros == 15_000_000

    account = credits_service.get_or_create_account(db_session, organization.id)
    assert account.balance_micros == 15_000_000


def test_debit_reduces_balance(db_session, organization):
    credits_service.record_transaction(
        db_session, organization_id=organization.id, type=CreditTransactionType.MONTHLY_GRANT,
        amount_micros=10_000_000, description="grant",
    )
    credits_service.record_transaction(
        db_session, organization_id=organization.id, type=CreditTransactionType.USAGE,
        amount_micros=-3_000_000, description="usage",
    )
    account = credits_service.get_or_create_account(db_session, organization.id)
    assert account.balance_micros == 7_000_000


def test_debit_below_zero_raises_without_overdraft(db_session, organization):
    with pytest.raises(credits_service.InsufficientCreditsError):
        credits_service.record_transaction(
            db_session, organization_id=organization.id, type=CreditTransactionType.USAGE,
            amount_micros=-1_000_000, description="usage with no balance",
        )


def test_overdraft_allowed_when_explicitly_flagged(db_session, organization):
    # Used only for the "request already ran, must still be billed" case
    # in the gateway (see app/api/gateway.py) — never for pre-authorization.
    txn = credits_service.record_transaction(
        db_session, organization_id=organization.id, type=CreditTransactionType.USAGE,
        amount_micros=-500_000, description="usage", allow_overdraft=True,
    )
    assert txn.balance_after_micros == -500_000


def test_ledger_is_append_only_and_auditable(db_session, organization):
    credits_service.record_transaction(
        db_session, organization_id=organization.id, type=CreditTransactionType.MONTHLY_GRANT,
        amount_micros=5_000_000, description="a",
    )
    credits_service.record_transaction(
        db_session, organization_id=organization.id, type=CreditTransactionType.USAGE,
        amount_micros=-1_000_000, description="b",
    )
    from sqlalchemy import select

    from app.models.billing import CreditTransaction

    rows = db_session.execute(
        select(CreditTransaction).where(CreditTransaction.organization_id == organization.id).order_by(CreditTransaction.created_at)
    ).scalars().all()
    assert [r.balance_after_micros for r in rows] == [5_000_000, 4_000_000]
