"""
Immutable account statements.

The statement is assembled exclusively from append-only sources — the
CreditTransaction ledger, the Invoice table, and the GpuInstance rental
history — so a snapshot can never contradict the records it was built from.
Each generation inserts a NEW row into account_statements (never updates an
existing one), and every snapshot carries a SHA-256 of its canonical JSON so
the read path can prove the stored document hasn't been altered. This is
what makes the statement "read-only" in a meaningful sense: users can download
it, but no code path anywhere can edit or delete a stored snapshot.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.billing import (
    AccountStatement,
    CreditAccount,
    CreditTransaction,
    CreditTransactionType,
    Invoice,
    MICROS_PER_GBP,
    Plan,
    Subscription,
    SubscriptionStatus,
    StripeCustomer,
)
from app.models.compute import GpuInstance
from app.models.org import Organization

STATEMENT_FORMAT_VERSION = 1

# How many historical snapshots the history endpoint returns at most.
STATEMENT_HISTORY_LIMIT = 100


class StatementTamperedError(Exception):
    """A stored statement row no longer matches its recorded hash."""


def canonical_bytes(content: dict) -> bytes:
    """
    Canonical JSON encoding used for hashing: sorted keys, no whitespace,
    non-ASCII preserved. Deterministic across runs so the same content
    always hashes the same way.
    """
    return json.dumps(
        content, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    ).encode("utf-8")


def sha256_hex(content: dict) -> str:
    return hashlib.sha256(canonical_bytes(content)).hexdigest()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def build_statement(db: Session, org_id: uuid.UUID) -> dict:
    """
    Assemble the full billing statement for an organization from its
    append-only records. Pure read — never writes anything.
    """
    org = db.get(Organization, org_id)
    if org is None:
        raise LookupError("Organization not found")

    plan: Plan | None = None
    subscription_row = db.execute(
        select(Subscription).where(Subscription.organization_id == org_id)
    ).scalar_one_or_none()
    if subscription_row is not None:
        plan = db.get(Plan, subscription_row.plan_id)

    credit_account = db.execute(
        select(CreditAccount).where(CreditAccount.organization_id == org_id)
    ).scalar_one_or_none()

    stripe_customer = db.execute(
        select(StripeCustomer).where(StripeCustomer.organization_id == org_id)
    ).scalar_one_or_none()

    transactions = (
        db.execute(
            select(CreditTransaction)
            .where(CreditTransaction.organization_id == org_id)
            .order_by(CreditTransaction.created_at.asc())
        )
        .scalars()
        .all()
    )

    invoices = (
        db.execute(
            select(Invoice)
            .where(Invoice.organization_id == org_id)
            .order_by(Invoice.created_at.asc())
        )
        .scalars()
        .all()
    )

    rentals = (
        db.execute(
            select(GpuInstance)
            .where(GpuInstance.organization_id == org_id)
            .order_by(GpuInstance.created_at.asc())
        )
        .scalars()
        .all()
    )

    # Per-type ledger totals — the document's summary numbers, all derived
    # from the same transaction rows listed below it.
    totals: dict[str, int] = {t.value: 0 for t in CreditTransactionType}
    for tx in transactions:
        totals[tx.type.value] += tx.amount_micros

    content = {
        "format_version": STATEMENT_FORMAT_VERSION,
        "currency": "GBP",
        "note": (
            "This statement is generated from TaskFlow's append-only billing "
            "ledger. It is read-only: stored snapshots cannot be edited or "
            "deleted, and each one is hashed so its integrity can be verified."
        ),
        "organization": {
            "id": str(org.id),
            "name": org.name,
            "created_at": _iso(org.created_at),
        },
        "plan": (
            {
                "code": plan.code.value if plan else None,
                "display_name": plan.display_name if plan else None,
                "monthly_price_micros": plan.monthly_price_micros if plan else None,
            }
            if plan
            else None
        ),
        "subscription": (
            {
                "status": subscription_row.status.value,
                "current_period_start": _iso(subscription_row.current_period_start),
                "current_period_end": _iso(subscription_row.current_period_end),
                "cancel_at_period_end": subscription_row.cancel_at_period_end,
                "stripe_subscription_id": subscription_row.stripe_subscription_id,
            }
            if subscription_row
            else None
        ),
        "stripe_customer_id": stripe_customer.stripe_customer_id if stripe_customer else None,
        "credit_balance_micros": credit_account.balance_micros if credit_account else 0,
        "credit_balance_display": f"£{(credit_account.balance_micros if credit_account else 0) / MICROS_PER_GBP:.2f}",
        "totals_micros": totals,
        "credit_transactions": [
            {
                "id": str(tx.id),
                "type": tx.type.value,
                "amount_micros": tx.amount_micros,
                "balance_after_micros": tx.balance_after_micros,
                "description": tx.description,
                "stripe_event_id": tx.stripe_event_id,
                "stripe_payment_intent_id": tx.stripe_payment_intent_id,
                "stripe_checkout_session_id": tx.stripe_checkout_session_id,
                "created_at": _iso(tx.created_at),
            }
            for tx in transactions
        ],
        # hosted_invoice_url is Stripe's own receipt document — the
        # authoritative payment document for each subscription payment.
        "invoices": [
            {
                "stripe_invoice_id": inv.stripe_invoice_id,
                "amount_due_micros": inv.amount_due_micros,
                "amount_paid_micros": inv.amount_paid_micros,
                "amount_due_display": f"£{inv.amount_due_micros / MICROS_PER_GBP:.2f}",
                "amount_paid_display": f"£{inv.amount_paid_micros / MICROS_PER_GBP:.2f}",
                "status": inv.status,
                "hosted_invoice_url": inv.hosted_invoice_url,
                "created_at": _iso(inv.created_at),
            }
            for inv in invoices
        ],
        "gpu_rentals": [
            {
                "id": str(r.id),
                "status": r.status.value,
                "payment_mode": r.payment_mode.value,
                "gpu_type_slug": r.gpu_type.slug,
                "gpu_type_display_name": r.gpu_type.display_name,
                "hourly_rate_micros": r.hourly_rate_micros,
                "total_charged_micros": r.total_charged_micros,
                "total_charged_display": f"£{r.total_charged_micros / MICROS_PER_GBP:.2f}",
                "storage_gb": r.storage_gb,
                "started_at": _iso(r.started_at),
                "stopped_at": _iso(r.stopped_at),
                "created_at": _iso(r.created_at),
            }
            for r in rentals
        ],
    }
    return content


def record_statement(
    db: Session, org_id: uuid.UUID, content: dict, generated_by_user_id: uuid.UUID | None
) -> AccountStatement:
    """
    Persist one immutable snapshot. Append-only: this function must NEVER
    update or delete rows — a new statement is always a new row.
    """
    row = AccountStatement(
        organization_id=org_id,
        format_version=STATEMENT_FORMAT_VERSION,
        content=content,
        content_sha256=sha256_hex(content),
        generated_at=datetime.now(timezone.utc),
        generated_by_user_id=generated_by_user_id,
    )
    db.add(row)
    db.flush()
    return row


def verify_statement(row: AccountStatement) -> None:
    """
    Re-hash the stored content and compare with the recorded hash. A mismatch
    means the row was mutated outside the app — surface that loudly rather
    than serving silently altered financial data.
    """
    if sha256_hex(row.content) != row.content_sha256:
        raise StatementTamperedError(
            f"Account statement {row.id} failed integrity verification — "
            "its stored content no longer matches its recorded hash."
        )


def get_statement(db: Session, org_id: uuid.UUID, statement_id: uuid.UUID) -> AccountStatement:
    """
    Fetch one stored snapshot, enforcing tenant isolation and integrity.
    Raises LookupError if not found (or owned by another org) and
    StatementTamperedError if the row was mutated.
    """
    row = db.get(AccountStatement, statement_id)
    if row is None or row.organization_id != org_id:
        raise LookupError("Account statement not found")
    verify_statement(row)
    return row


def list_statements(db: Session, org_id: uuid.UUID, limit: int = STATEMENT_HISTORY_LIMIT) -> list[dict]:
    """
    Snapshot history, newest first. Metadata only — full content comes from
    the per-snapshot endpoint.
    """
    rows = (
        db.execute(
            select(AccountStatement)
            .where(AccountStatement.organization_id == org_id)
            .order_by(AccountStatement.generated_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": str(r.id),
            "format_version": r.format_version,
            "content_sha256": r.content_sha256,
            "generated_at": _iso(r.generated_at),
            "generated_by_user_id": str(r.generated_by_user_id) if r.generated_by_user_id else None,
        }
        for r in rows
    ]


def generate_statement(
    db: Session, org_id: uuid.UUID, generated_by_user_id: uuid.UUID | None
) -> dict:
    """
    Build a fresh statement and persist it as a new immutable snapshot.
    Returns the content plus its snapshot metadata. Callers own the
    surrounding transaction (commit/rollback), matching every other
    endpoint in this codebase.
    """
    content = build_statement(db, org_id)
    row = record_statement(db, org_id, content, generated_by_user_id)
    return {
        "statement": content,
        "statement_id": str(row.id),
        "content_sha256": row.content_sha256,
        "generated_at": _iso(row.generated_at),
        "format_version": row.format_version,
    }
