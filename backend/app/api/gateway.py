from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.auth.maintenance import block_if_maintenance_unconditional
from app.models.api_key import ApiKey
from app.models.billing import CreditTransactionType, Plan, Subscription, SubscriptionStatus
from app.models.catalog import AiModel, ModelEntitlement, ModelStatus, Provider
from app.models.usage import UsageEvent, UsageEventStatus
from app.providers.base import ProviderRequestError
from app.providers.registry import get_provider
from app.services import api_keys as api_key_service
from app.services import credits as credits_service
from app.services import pricing as pricing_service

router = APIRouter(prefix="/v1", tags=["gateway"], dependencies=[Depends(block_if_maintenance_unconditional)])


async def authenticate(authorization: str | None = Header(default=None), db: Session = Depends(get_db)) -> ApiKey:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing API key")
    raw_key = authorization.split(" ", 1)[1]
    key = api_key_service.authenticate_api_key(db, raw_key)
    if not key:
        raise HTTPException(401, "Invalid or revoked API key")
    return key


@router.get("/models")
def list_models(api_key: ApiKey = Depends(authenticate), db: Session = Depends(get_db)):
    sub = db.execute(select(Subscription).where(Subscription.organization_id == api_key.organization_id)).scalar_one_or_none()
    plan = db.get(Plan, sub.plan_id) if sub else None
    plan_code = plan.code if plan else None

    models = db.execute(select(AiModel).where(AiModel.enabled == True, AiModel.status == ModelStatus.LIVE)).scalars()  # noqa: E712
    result = []
    for m in models:
        entitlements = {e.plan_code for e in m.entitlements}
        if plan_code and plan_code not in entitlements:
            continue
        result.append({"id": m.slug, "object": "model", "owned_by": "taskflow"})
    return {"object": "list", "data": result}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    temperature: float | None = None
    max_tokens: int | None = None


@router.post("/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest, api_key: ApiKey = Depends(authenticate), db: Session = Depends(get_db)
):
    org_id = api_key.organization_id

    # 1. Resolve subscription/plan/entitlement
    sub = db.execute(select(Subscription).where(Subscription.organization_id == org_id)).scalar_one_or_none()
    if not sub or sub.status not in (SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING):
        raise HTTPException(402, "Organization does not have an active subscription")
    plan = db.get(Plan, sub.plan_id)

    model = db.execute(select(AiModel).where(AiModel.slug == body.model)).scalar_one_or_none()
    if not model or not model.enabled or model.status != ModelStatus.LIVE:
        raise HTTPException(404, f"Model '{body.model}' is not available")

    entitled_plans = {e.plan_code for e in model.entitlements}
    if plan.code not in entitled_plans:
        raise HTTPException(403, f"Model '{body.model}' is not available on the {plan.code.value} plan")

    provider = db.get(Provider, model.provider_id)
    adapter = get_provider(provider.kind.value)
    if not adapter or not adapter.is_configured():
        _record_rejected(db, org_id, model.id, provider.id, "Provider not configured")
        raise HTTPException(503, f"Provider '{provider.kind.value}' is not currently configured")

    # 2. Estimate a conservative pre-authorization charge so we never let a
    #    request through with an empty/negative balance (credit safety, docs §43).
    account = credits_service.get_or_create_account(db, org_id)
    if account.balance_micros <= 0:
        _record_rejected(db, org_id, model.id, provider.id, "Insufficient credits")
        db.commit()
        raise HTTPException(402, "Insufficient credit balance")

    # 3. Dispatch to the provider. Only AFTER this succeeds do we charge —
    #    a request that never reaches the provider is never billed as success.
    try:
        result = await adapter.chat_completion(
            model_identifier=model.model_identifier,
            messages=[m.model_dump() for m in body.messages],
            temperature=body.temperature,
            max_tokens=body.max_tokens,
        )
    except ProviderRequestError as exc:
        _record_provider_error(db, org_id, model.id, provider.id, str(exc))
        db.commit()
        raise HTTPException(exc.status_code, str(exc))

    # 4. Price and charge, transactionally, only on confirmed success.
    priced = pricing_service.price_chat_usage(db, model, result.input_tokens, result.output_tokens)

    event = UsageEvent(
        id=uuid.uuid4(),
        organization_id=org_id,
        api_key_id=api_key.id,
        model_id=model.id,
        provider_id=provider.id,
        status=UsageEventStatus.SUCCESS,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        total_tokens=result.input_tokens + result.output_tokens,
        provider_cost_micros=priced.provider_cost_micros,
        gpu_cost_micros=priced.gpu_cost_micros,
        margin_micros=priced.margin_micros,
        charge_micros=priced.charge_micros,
        latency_ms=result.latency_ms,
        created_at=datetime.now(timezone.utc),
    )
    db.add(event)
    db.flush()

    try:
        credits_service.record_transaction(
            db,
            organization_id=org_id,
            type=CreditTransactionType.USAGE,
            amount_micros=-priced.charge_micros,
            description=f"{model.display_name} usage",
            allow_overdraft=True,  # request already ran; never leave an unbilled successful request
            usage_event_id=event.id,
        )
    finally:
        db.commit()

    return {
        "id": f"chatcmpl_{event.id}",
        "object": "chat.completion",
        "model": body.model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": result.content}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": result.input_tokens,
            "completion_tokens": result.output_tokens,
            "total_tokens": result.input_tokens + result.output_tokens,
        },
        "taskflow": {
            "charge_micros": priced.charge_micros,
            "balance_micros": credits_service.get_or_create_account(db, org_id).balance_micros,
            "provider": provider.kind.value,
        },
    }


def _record_rejected(db: Session, org_id: uuid.UUID, model_id, provider_id, detail: str) -> None:
    db.add(
        UsageEvent(
            id=uuid.uuid4(),
            organization_id=org_id,
            model_id=model_id,
            provider_id=provider_id,
            status=UsageEventStatus.REJECTED,
            error_detail=detail[:500],
            created_at=datetime.now(timezone.utc),
        )
    )


def _record_provider_error(db: Session, org_id: uuid.UUID, model_id, provider_id, detail: str) -> None:
    db.add(
        UsageEvent(
            id=uuid.uuid4(),
            organization_id=org_id,
            model_id=model_id,
            provider_id=provider_id,
            status=UsageEventStatus.PROVIDER_ERROR,
            error_detail=detail[:500],
            created_at=datetime.now(timezone.utc),
        )
    )
