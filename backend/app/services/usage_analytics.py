"""
Read-only GPU usage/spend analytics for the customer dashboard. Never
mutates the ledger, never touches billing or provisioning — pure reporting
over data that already exists in CreditTransaction (type GPU_USAGE) and
GpuInstance.

This is Postgres-only by design (date_trunc/generate_series), matching the
rest of this project. See tests/test_usage_analytics.py, which runs against
a real local Postgres rather than the shared SQLite test fixture, since
these functions genuinely cannot execute correctly under SQLite.

Hours are always derived from actual charged amounts (ledger amount_micros
divided by the instance's own hourly_rate_micros at the time it was
charged), never from wall-clock timestamp arithmetic — a stopped/resumed
rental's billed hours must match what was actually charged, which is the
ledger's job.

Known limitation: by_gpu_type/most_used_gpu_type can only include
CreditTransaction rows that have gpu_instance_id set. That column was added
alongside this feature — any GPU_USAGE ledger rows written before it will
correctly still count toward total_spend_micros/spend_by_bucket (queried
directly off the ledger with no join), but won't appear in the by-tier
breakdown, since there's no way to recover which tier they belonged to
after the fact.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

Period = Literal["day", "month", "year"]

# unit: the date_trunc() granularity. step: the generate_series() increment,
# as a literal interval string — always one of these three fixed,
# code-controlled values, never interpolated from user input.
_PERIOD_CONFIG: dict[str, dict] = {
    "day": {"unit": "hour", "step": "1 hour", "count": 24},
    "month": {"unit": "day", "step": "1 day", "count": 30},
    "year": {"unit": "month", "step": "1 month", "count": 12},
}


def _window_start(period: Period, now: datetime) -> datetime:
    now = now.astimezone(timezone.utc)
    if period == "day":
        current_hour = now.replace(minute=0, second=0, microsecond=0)
        return current_hour - timedelta(hours=23)  # this hour + the 23 before it = 24 buckets
    if period == "month":
        current_day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return current_day - timedelta(days=29)  # today + the 29 before it = 30 buckets
    if period == "year":
        first_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        # 12 clean calendar-month buckets ending with the current (possibly
        # partial) month — not a rolling 365-day window.
        total = (first_of_month.year * 12 + (first_of_month.month - 1)) - 11
        y2, m2 = divmod(total, 12)
        return first_of_month.replace(year=y2, month=m2 + 1)
    raise ValueError(f"Unknown period: {period}")


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class GpuTypeUsage:
    slug: str
    display_name: str
    hours: float
    spend_micros: int


def get_usage_summary(db: Session, organization_id: uuid.UUID, period: Period, now: Optional[datetime] = None) -> dict:
    now = now or datetime.now(timezone.utc)
    cfg = _PERIOD_CONFIG[period]
    start = _window_start(period, now)

    # spend_by_bucket: generate the full expected bucket sequence with
    # generate_series and LEFT JOIN the aggregated ledger onto it, so every
    # bucket in the window is present even with zero spend — the frontend
    # needs a continuous series, not one it has to fill gaps in itself.
    bucket_rows = db.execute(
        text(
            f"""
            WITH buckets AS (
                SELECT generate_series(
                    :start ::timestamptz,
                    :start ::timestamptz + :span ::interval,
                    :step ::interval
                ) AS bucket_start
            ),
            agg AS (
                SELECT date_trunc(:unit, created_at) AS bucket_start,
                       SUM(-amount_micros) AS spend_micros
                FROM credit_transactions
                WHERE organization_id = :org_id
                  AND type = 'GPU_USAGE'
                  AND created_at >= :start ::timestamptz
                GROUP BY date_trunc(:unit, created_at)
            )
            SELECT b.bucket_start, COALESCE(agg.spend_micros, 0) AS spend_micros
            FROM buckets b
            LEFT JOIN agg ON b.bucket_start = agg.bucket_start
            ORDER BY b.bucket_start
            """
        ),
        {
            "start": start,
            "span": f"{cfg['count'] - 1} {cfg['unit']}s",
            "step": cfg["step"],
            "unit": cfg["unit"],
            "org_id": str(organization_id),
        },
    ).all()

    spend_by_bucket = [{"bucket_start": _iso_z(row.bucket_start), "spend_micros": int(row.spend_micros)} for row in bucket_rows]
    total_spend_micros = sum(b["spend_micros"] for b in spend_by_bucket)

    # by_gpu_type: joined through gpu_instance_id, so only rows written
    # after that column existed are included (see module docstring).
    tier_rows = db.execute(
        text(
            """
            SELECT gt.slug AS slug,
                   gt.display_name AS display_name,
                   SUM(-ct.amount_micros) AS spend_micros,
                   SUM((-ct.amount_micros)::float / NULLIF(gi.hourly_rate_micros, 0)) AS hours
            FROM credit_transactions ct
            JOIN gpu_instances gi ON gi.id = ct.gpu_instance_id
            JOIN gpu_types gt ON gt.id = gi.gpu_type_id
            WHERE ct.organization_id = :org_id
              AND ct.type = 'GPU_USAGE'
              AND ct.created_at >= :start ::timestamptz
            GROUP BY gt.slug, gt.display_name
            ORDER BY hours DESC
            """
        ),
        {"org_id": str(organization_id), "start": start},
    ).all()

    by_gpu_type = [
        {
            "slug": row.slug,
            "display_name": row.display_name,
            "hours": round(float(row.hours or 0.0), 2),
            "spend_micros": int(row.spend_micros or 0),
        }
        for row in tier_rows
    ]
    total_gpu_hours = round(sum(t["hours"] for t in by_gpu_type), 2)
    most_used_gpu_type = by_gpu_type[0] if by_gpu_type else None

    return {
        "period": period,
        "total_spend_micros": total_spend_micros,
        "total_gpu_hours": total_gpu_hours,
        "spend_by_bucket": spend_by_bucket,
        "most_used_gpu_type": most_used_gpu_type,
        "by_gpu_type": by_gpu_type,
    }
