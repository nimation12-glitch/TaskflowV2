from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context, require_role
from app.database import get_db
from app.models.api_key import ApiKey
from app.models.org import Role
from app.services import api_keys as api_key_service

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


class CreateApiKeyRequest(BaseModel):
    name: str


@router.get("")
def list_api_keys(ctx: RequestContext = Depends(require_context), db: Session = Depends(get_db)):
    rows = db.execute(
        select(ApiKey).where(ApiKey.organization_id == ctx.organization_id).order_by(ApiKey.created_at.desc())
    ).scalars()
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "prefix": r.prefix,
            "status": r.status.value,
            "created_at": r.created_at.isoformat(),
            "last_used_at": r.last_used_at.isoformat() if r.last_used_at else None,
        }
        for r in rows
    ]


@router.post("")
def create_api_key(
    body: CreateApiKeyRequest,
    ctx: RequestContext = Depends(require_role(Role.OWNER, Role.ADMIN)),
    db: Session = Depends(get_db),
):
    row, raw_key = api_key_service.generate_api_key(db, ctx.organization_id, ctx.user_id, body.name)
    db.commit()
    return {
        "id": str(row.id),
        "name": row.name,
        "prefix": row.prefix,
        "raw_key": raw_key,  # shown exactly once — frontend must warn the user and never re-fetch it
        "created_at": row.created_at.isoformat(),
    }


@router.delete("/{key_id}")
def revoke_api_key(
    key_id: uuid.UUID,
    ctx: RequestContext = Depends(require_role(Role.OWNER, Role.ADMIN)),
    db: Session = Depends(get_db),
):
    ok = api_key_service.revoke_api_key(db, ctx.organization_id, key_id)
    db.commit()
    if not ok:
        raise HTTPException(404, "API key not found")
    return {"revoked": True}
