"""
Credit ledger.

Rule: nobody mutates CreditAccount.balance_micros directly. Every change goes
through record_transaction(), which writes an immutable CreditTransaction row
in the same DB transaction as the balance update, so the balance is always a
reliable transactional aggregate over the ledger (see docs/AGENTS.md §17 / §12).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.billing import CreditAccount, CreditTransaction, CreditTransactionType


class InsufficientCreditsError(Exception):
    pass


def get_or_create_account(db: Session, organization_id: uuid.UUID) -> CreditAccount:
    account = db.execute(
        select(CreditAccount).where(CreditAccount.organization_id == organization_id).with_for_update()
    ).scalar_one_or_none()
    if account:
        return account
    account = CreditAccount(organization_id=organization_id, balance_micros=0)
    db.add(account)
    db.flush()
    return account


def record_transaction(
    db: Session,
    *,
    organization_id: uuid.UUID,
    type: CreditTransactionType,
    amount_micros: int,
    description: str,
    allow_overdraft: bool = False,
    stripe_event_id: str | None = None,
    stripe_payment_intent_id: str | None = None,
    stripe_checkout_session_id: str | None = None,
    usage_event_id: uuid.UUID | None = None,
    gpu_instance_id: uuid.UUID | None = None,
) -> CreditTransaction:
    """
    amount_micros: positive to credit, negative to debit.
    Row-locks the credit account for the duration of this DB transaction to
    prevent concurrent requests from racing past a zero balance.
    """
    account = get_or_create_account(db, organization_id)

    new_balance = account.balance_micros + amount_micros
    if new_balance < 0 and not allow_overdraft:
        raise InsufficientCreditsError(
            f"Insufficient credits: balance={account.balance_micros} attempted_debit={amount_micros}"
        )

    account.balance_micros = new_balance
    txn = CreditTransaction(
        id=uuid.uuid4(),
        organization_id=organization_id,
        type=type,
        amount_micros=amount_micros,
        balance_after_micros=new_balance,
        description=description,
        created_at=datetime.now(timezone.utc),
        stripe_event_id=stripe_event_id,
        stripe_payment_intent_id=stripe_payment_intent_id,
        stripe_checkout_session_id=stripe_checkout_session_id,
        usage_event_id=usage_event_id,
        gpu_instance_id=gpu_instance_id,
    )
    db.add(txn)
    db.flush()
    return txn
