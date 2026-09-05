from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.database import get_db
from app.models.usage import UsageEvent, UsageEventStatus

router = APIRouter(prefix="/usage", tags=["usage"])


@router.get("/events")
def list_usage_events(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
    limit: int = Query(default=50, le=200),
):
    rows = db.execute(
        select(UsageEvent)
        .where(UsageEvent.organization_id == ctx.organization_id)
        .order_by(UsageEvent.created_at.desc())
        .limit(limit)
    ).scalars()
    return [
        {
            "id": str(e.id),
            "status": e.status.value,
            "model_id": str(e.model_id) if e.model_id else None,
            "input_tokens": e.input_tokens,
            "output_tokens": e.output_tokens,
            "total_tokens": e.total_tokens,
            "charge_micros": e.charge_micros,
            "latency_ms": e.latency_ms,
            "created_at": e.created_at.isoformat(),
        }
        for e in rows
    ]


@router.get("/summary")
def usage_summary(ctx: RequestContext = Depends(require_context), db: Session = Depends(get_db)):
    row = db.execute(
        select(
            func.count().filter(UsageEvent.status == UsageEventStatus.SUCCESS),
            func.coalesce(func.sum(UsageEvent.input_tokens), 0),
            func.coalesce(func.sum(UsageEvent.output_tokens), 0),
            func.coalesce(func.sum(UsageEvent.charge_micros), 0),
        ).where(UsageEvent.organization_id == ctx.organization_id, UsageEvent.status == UsageEventStatus.SUCCESS)
    ).one()
    requests, input_tokens, output_tokens, total_charge_micros = row
    return {
        "requests": requests,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "total_charge_micros": total_charge_micros,
    }
