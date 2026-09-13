"""
Seed baseline reference data: Plans, Providers, and the initial AiModel catalog.

Run with: python -m scripts.seed
Safe to re-run — upserts by unique key, never duplicates.

IMPORTANT: models are only marked status=LIVE if their provider is actually
configured (real API key present) AND commercial_use_reviewed=True. Nothing
here fabricates a working model. See docs/AGENTS.md §6.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select

from app.config import get_settings
from app.database import SessionLocal
from app.models.billing import Plan, PlanCode
from app.models.catalog import AiModel, HostingMode, ModelEntitlement, ModelPricing, ModelStatus, Provider, ProviderKind
from app.models.compute import GpuType
from app.providers.registry import configured_providers

PLAN_DEFAULTS = [
    dict(
        code=PlanCode.FREE,
        display_name="Free",
        monthly_price_micros=0,
        monthly_credit_micros=2_000_000,
        rate_limit_rpm=20,
        compute_priority=0,
        max_members=3,
        allows_gpu_rental=True,
        gpu_max_concurrent_rentals=1,
        gpu_max_storage_gb=50,
        gpu_max_session_hours=4,
        gpu_booking_allowed=False,
        gpu_max_booking_days=0,
        gpu_rate_bps=10_000,
    ),
    dict(
        code=PlanCode.PRO,
        display_name="Pro",
        monthly_price_micros=30_000_000,
        monthly_credit_micros=15_000_000,
        rate_limit_rpm=100,
        compute_priority=1,
        max_members=10,
        allows_gpu_rental=True,
        gpu_max_concurrent_rentals=3,
        gpu_max_storage_gb=250,
        gpu_max_session_hours=24 * 7,
        gpu_booking_allowed=True,
        gpu_max_booking_days=7,
        gpu_rate_bps=9_000,
    ),
    dict(
        code=PlanCode.MAX,
        display_name="Max",
        monthly_price_micros=90_000_000,
        monthly_credit_micros=50_000_000,
        rate_limit_rpm=300,
        compute_priority=2,
        max_members=25,
        allows_gpu_rental=True,
        gpu_max_concurrent_rentals=10,
        gpu_max_storage_gb=500,
        gpu_max_session_hours=24 * 14,
        gpu_booking_allowed=True,
        gpu_max_booking_days=14,
        gpu_rate_bps=8_000,
    ),
]

# Matches frontend/lib/gpu-catalog-reference.ts exactly. AMI_ID and AWS_REGION
# are intentionally left for the founder to fill in per environment — real
# AMI IDs are region- and time-specific, and this seed script should never
# fabricate one. GpuType.enabled defaults to False until ami_id is set and
# reviewed, mirroring the AiModel NOT_CONFIGURED gating pattern below: never
# silently present a tier that can't actually be provisioned.
GPU_TYPE_DEFAULTS = [
    dict(
        slug="starter",
        display_name="Starter",
        gpu_label="NVIDIA T4",
        aws_instance_type="g4dn.xlarge",
        vram_gb=16,
        vcpu=4,
        ram_gb=16,
        price_micros_per_hour=750_000,
    ),
    dict(
        slug="standard",
        display_name="Standard",
        gpu_label="NVIDIA A10G",
        aws_instance_type="g5.xlarge",
        vram_gb=24,
        vcpu=4,
        ram_gb=16,
        price_micros_per_hour=1_400_000,
    ),
    dict(
        slug="performance",
        display_name="Performance",
        gpu_label="NVIDIA A10G",
        aws_instance_type="g5.2xlarge",
        vram_gb=24,
        vcpu=8,
        ram_gb=32,
        price_micros_per_hour=1_700_000,
    ),
    dict(
        slug="max",
        display_name="Max",
        gpu_label="NVIDIA A10G",
        aws_instance_type="g5.4xlarge",
        vram_gb=24,
        vcpu=16,
        ram_gb=64,
        price_micros_per_hour=2_250_000,
    ),
]

PROVIDER_DEFAULTS = [
    (ProviderKind.NVIDIA, "NVIDIA"),
    (ProviderKind.MOONSHOT, "Moonshot"),
    (ProviderKind.OPENROUTER, "OpenRouter"),
]

# Example catalog entries — real model_identifier strings for each provider's
# own API. Enabled only when the provider is actually configured.
MODEL_DEFAULTS = [
    dict(
        slug="kimi-k2",
        display_name="Kimi K2",
        version="1.0",
        provider=ProviderKind.MOONSHOT,
        model_identifier="moonshot-v1-32k",
        hosting_mode=HostingMode.EXTERNAL_API,
        source="Moonshot AI",
        license="Proprietary API access",
        commercial_use_reviewed=True,
        context_window=32000,
        capabilities={"chat": True},
        entitled_plans=[PlanCode.PRO, PlanCode.MAX],
        pricing=dict(input_micros_per_1k=8_000, output_micros_per_1k=20_000, gpu_micros_per_sec=0, margin_bps=1500),
    ),
    dict(
        slug="llama-3-8b",
        display_name="Llama 3 8B (via NVIDIA NIM)",
        version="3.0",
        provider=ProviderKind.NVIDIA,
        model_identifier="meta/llama3-8b-instruct",
        hosting_mode=HostingMode.EXTERNAL_API,
        source="Meta / NVIDIA NIM",
        license="Llama 3 Community License",
        commercial_use_reviewed=True,
        context_window=8192,
        capabilities={"chat": True},
        entitled_plans=[PlanCode.FREE, PlanCode.PRO, PlanCode.MAX],
        pricing=dict(input_micros_per_1k=2_000, output_micros_per_1k=4_000, gpu_micros_per_sec=0, margin_bps=1500),
    ),
]


def run():
    db = SessionLocal()
    try:
        for defaults in PLAN_DEFAULTS:
            existing = db.execute(select(Plan).where(Plan.code == defaults["code"])).scalar_one_or_none()
            if existing:
                for k, v in defaults.items():
                    setattr(existing, k, v)
            else:
                db.add(Plan(**defaults))
        db.commit()

        settings = get_settings()
        for defaults in GPU_TYPE_DEFAULTS:
            existing_gt = db.execute(select(GpuType).where(GpuType.slug == defaults["slug"])).scalar_one_or_none()
            if existing_gt:
                for k, v in defaults.items():
                    setattr(existing_gt, k, v)
            else:
                db.add(GpuType(aws_region=settings.aws_region, ami_id=None, enabled=False, **defaults))
        db.commit()

        configured = set(configured_providers())
        provider_rows: dict[ProviderKind, Provider] = {}
        for kind, display_name in PROVIDER_DEFAULTS:
            existing = db.execute(select(Provider).where(Provider.kind == kind)).scalar_one_or_none()
            enabled = kind.value in configured
            if existing:
                existing.display_name = display_name
                existing.enabled = enabled
                provider_rows[kind] = existing
            else:
                p = Provider(kind=kind, display_name=display_name, enabled=enabled)
                db.add(p)
                db.flush()
                provider_rows[kind] = p
        db.commit()

        for m in MODEL_DEFAULTS:
            provider = provider_rows[m["provider"]]
            existing = db.execute(select(AiModel).where(AiModel.slug == m["slug"])).scalar_one_or_none()
            status = ModelStatus.LIVE if provider.enabled and m["commercial_use_reviewed"] else ModelStatus.NOT_CONFIGURED

            if existing:
                model = existing
                model.display_name = m["display_name"]
                model.enabled = provider.enabled
                model.status = status
            else:
                model = AiModel(
                    slug=m["slug"],
                    display_name=m["display_name"],
                    version=m["version"],
                    provider_id=provider.id,
                    model_identifier=m["model_identifier"],
                    hosting_mode=m["hosting_mode"],
                    source=m["source"],
                    license=m["license"],
                    commercial_use_reviewed=m["commercial_use_reviewed"],
                    context_window=m["context_window"],
                    capabilities=m["capabilities"],
                    enabled=provider.enabled,
                    status=status,
                )
                db.add(model)
                db.flush()

            existing_ents = {e.plan_code for e in db.execute(select(ModelEntitlement).where(ModelEntitlement.model_id == model.id)).scalars()}
            for plan_code in m["entitled_plans"]:
                if plan_code not in existing_ents:
                    db.add(ModelEntitlement(model_id=model.id, plan_code=plan_code))

            existing_pricing = db.execute(select(ModelPricing).where(ModelPricing.model_id == model.id)).scalar_one_or_none()
            if not existing_pricing:
                db.add(
                    ModelPricing(
                        model_id=model.id,
                        input_token_price_micros_per_1k=m["pricing"]["input_micros_per_1k"],
                        output_token_price_micros_per_1k=m["pricing"]["output_micros_per_1k"],
                        gpu_price_micros_per_second=m["pricing"]["gpu_micros_per_sec"],
                        margin_bps=m["pricing"]["margin_bps"],
                    )
                )
        db.commit()
        print("Seed complete.")
        print(f"Configured providers: {sorted(configured) or '(none — set provider API keys in .env)'}")
        print(
            "GPU types seeded but all disabled by default — set GpuType.ami_id and "
            "enabled=True per tier once you've picked a real AMI for your region."
        )
    finally:
        db.close()


if __name__ == "__main__":
    run()
