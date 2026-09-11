from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.internal import RequestContext, require_context
from app.database import get_db
from app.services import ssh_keys as ssh_key_service

router = APIRouter(prefix="/account/ssh-keys", tags=["ssh-keys"])


class CreateSshKeyRequest(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    public_key: str = Field(min_length=1, max_length=4096)


def _serialize(key) -> dict:
    # Never return the full public key blob back out unnecessarily — the
    # fingerprint is enough for the user to confirm which key is which.
    return {
        "id": str(key.id),
        "label": key.label,
        "fingerprint": key.fingerprint,
        "created_at": key.created_at.isoformat(),
    }


@router.get("")
def list_ssh_keys(
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    keys = ssh_key_service.list_ssh_keys(db, ctx.organization_id)
    return {"ssh_keys": [_serialize(k) for k in keys]}


@router.post("")
def create_ssh_key(
    body: CreateSshKeyRequest,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    try:
        key = ssh_key_service.create_ssh_key(db, ctx.organization_id, ctx.user_id, body.label, body.public_key)
        db.commit()
    except ssh_key_service.InvalidPublicKeyError as exc:
        db.rollback()
        raise HTTPException(400, str(exc))
    return _serialize(key)


@router.delete("/{ssh_key_id}")
def delete_ssh_key(
    ssh_key_id: str,
    ctx: RequestContext = Depends(require_context),
    db: Session = Depends(get_db),
):
    import uuid as _uuid

    try:
        key_id = _uuid.UUID(ssh_key_id)
    except ValueError:
        raise HTTPException(400, "Invalid SSH key id")

    try:
        key = ssh_key_service.delete_ssh_key(db, ctx.organization_id, key_id)
    except LookupError:
        raise HTTPException(404, "SSH key not found")
    except ssh_key_service.SshKeyInUseError as exc:
        db.rollback()
        raise HTTPException(409, str(exc))

    if key.aws_key_pair_name:
        from app.compute import aws_provider

        try:
            aws_provider.delete_ssh_key(key.aws_key_pair_name)
        except aws_provider.AwsProviderError as exc:
            # The DB row is already deleted in this transaction; don't block
            # the user on an AWS-side cleanup failure, but don't hide it either.
            db.commit()
            raise HTTPException(
                502,
                f"Key removed from your account, but AWS cleanup failed and needs manual attention: {exc}",
            )

    db.commit()
    return {"status": "deleted"}
