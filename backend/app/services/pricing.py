from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.catalog import AiModel, ModelPricing


@dataclass
class PricingResult:
    provider_cost_micros: int
    gpu_cost_micros: int
    margin_micros: int
    charge_micros: int


def price_chat_usage(db: Session, model: AiModel, input_tokens: int, output_tokens: int, gpu_seconds: float = 0.0) -> PricingResult:
    pricing = db.execute(
        select(ModelPricing).where(ModelPricing.model_id == model.id, ModelPricing.active == True)  # noqa: E712
    ).scalar_one_or_none()
    if pricing is None:
        raise ValueError(f"No active pricing configured for model {model.slug}")

    input_cost = (input_tokens * pricing.input_token_price_micros_per_1k) // 1000
    output_cost = (output_tokens * pricing.output_token_price_micros_per_1k) // 1000
    gpu_cost = int(gpu_seconds * pricing.gpu_price_micros_per_second)

    base_cost = input_cost + output_cost + gpu_cost
    margin = (base_cost * pricing.margin_bps) // 10_000
    charge = base_cost + margin

    return PricingResult(
        provider_cost_micros=input_cost + output_cost,
        gpu_cost_micros=gpu_cost,
        margin_micros=margin,
        charge_micros=charge,
    )
