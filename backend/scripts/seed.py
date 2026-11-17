"""
Seed baseline reference data: Plans, the GPU rental catalogue (spec §10),
Providers, and the AI-model catalog.

Run with: python -m scripts.seed
Safe to re-run — upserts by unique key, never duplicates.

Commercial model (product spec, AWS_GPU_Cloud_Catalogue_Final):
- Plans: Free £0 / Pro £35 / Ultra £65 / Max £100. A subscription buys ACCESS
  and workspace allowances — monthly_credit_micros is 0 on every plan and
  must stay 0. GPU time is always wallet-metered from top-ups.
- GPU prices are the spec's fixed base prices (§10). Base prices do not float
  with AWS. safe_infrastructure_cost_micros is the internal per-SKU ceiling
  (spec §11 safe-cost policy): seeded to the AWS GBP planning cost so the
  scheduler (Phase 3) refuses to provision a configuration whose projected
  infrastructure cost exceeds the plan the pricing was built on.
- New SKUs seed enabled=False: nothing is rentable until a real regional AMI
  is resolved (Phase 3, SSM) and the SKU is deliberately switched on.

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
from app.models.compute import GpuTier, GpuType
from app.models.region import GpuRegionAvailability, GpuRegionStatus, Region, RegionStatus
from app.models.workspace import StorageSize
from app.providers.registry import configured_providers

PLAN_DEFAULTS = [
    dict(
        code=PlanCode.FREE,
        display_name="Free",
        monthly_price_micros=0,
        monthly_credit_micros=0,  # access only — never grant compute (spec §3)
        rate_limit_rpm=20,
        compute_priority=0,
        max_members=3,
        allows_gpu_rental=True,
        gpu_max_concurrent_rentals=1,
        gpu_max_storage_gb=50,
        gpu_max_session_hours=4,
        gpu_booking_allowed=False,
        gpu_max_booking_days=0,
        gpu_rate_bps=10_000,  # no plan discounts: prices are fixed (spec §11)
        included_workspaces=1,  # spec §6/§7: 1 x 50GB workspace, hard slot limit
        workspace_storage_gb=50,
        gpu_max_tier=GpuTier.STARTER,
    ),
    dict(
        code=PlanCode.PRO,
        display_name="Pro",
        monthly_price_micros=35_000_000,
        monthly_credit_micros=0,
        rate_limit_rpm=100,
        compute_priority=1,
        max_members=10,
        allows_gpu_rental=True,
        gpu_max_concurrent_rentals=3,
        gpu_max_storage_gb=250,
        gpu_max_session_hours=24 * 7,
        gpu_booking_allowed=True,
        gpu_max_booking_days=7,
        gpu_rate_bps=10_000,
        included_workspaces=5,
        workspace_storage_gb=500,
        gpu_max_tier=GpuTier.STANDARD,
    ),
    dict(
        code=PlanCode.ULTRA,
        display_name="Ultra",
        monthly_price_micros=65_000_000,
        monthly_credit_micros=0,
        rate_limit_rpm=200,
        compute_priority=2,
        max_members=15,
        allows_gpu_rental=True,
        gpu_max_concurrent_rentals=6,
        gpu_max_storage_gb=500,
        gpu_max_session_hours=24 * 14,
        gpu_booking_allowed=True,
        gpu_max_booking_days=14,
        gpu_rate_bps=10_000,
        included_workspaces=10,
        workspace_storage_gb=500,
        gpu_max_tier=GpuTier.PRO,
    ),
    dict(
        code=PlanCode.MAX,
        display_name="Max",
        monthly_price_micros=100_000_000,
        monthly_credit_micros=0,
        rate_limit_rpm=300,
        compute_priority=3,
        max_members=25,
        allows_gpu_rental=True,
        gpu_max_concurrent_rentals=10,
        gpu_max_storage_gb=1024,
        gpu_max_session_hours=24 * 14,
        gpu_booking_allowed=True,
        gpu_max_booking_days=14,
        gpu_rate_bps=10_000,
        included_workspaces=15,
        workspace_storage_gb=1024,  # spec plan matrix: 1 TB per workspace
        gpu_max_tier=GpuTier.ULTRA,
    ),
]

# GPU rental catalogue — the full product spec §10 tables. Prices are the
# spec's fixed base prices (micro-GBP per hour); aws_cost is the spec's AWS
# GBP planning cost (internal margin tracking only, never exposed); safe cost
# is seeded equal to it per the §11 safe-cost policy. ram_gb is system memory
# from the AWS instance specs (the spec tables list vCPU/VRAM only).
#
# Tier assignment rule (spec §33): a SKU is tagged with the LOWEST tier whose
# catalogue lists it — T4 + L4 Nano → STARTER; rest of L4 + A10G → STANDARD;
# L40S → PRO; A100 + H100 → ULTRA. Plan gating is then a simple rank compare
# against Plan.gpu_max_tier.
GPU_TYPE_DEFAULTS = [
    # --- NVIDIA T4 — tier: STARTER (7 SKUs) ---
    dict(slug="t4-nano", display_name="T4 Nano", gpu_label="NVIDIA T4", tier=GpuTier.STARTER,
         aws_instance_type="g4dn.xlarge", gpu_count=1, vcpu=4, ram_gb=16, vram_gb=16,
         price_micros_per_hour=1_180_000, aws_cost_micros_per_hour=390_000,
         safe_infrastructure_cost_micros=390_000),
    dict(slug="t4-small", display_name="T4 Small", gpu_label="NVIDIA T4", tier=GpuTier.STARTER,
         aws_instance_type="g4dn.2xlarge", gpu_count=1, vcpu=8, ram_gb=32, vram_gb=16,
         price_micros_per_hour=1_670_000, aws_cost_micros_per_hour=560_000,
         safe_infrastructure_cost_micros=560_000),
    dict(slug="t4-medium", display_name="T4 Medium", gpu_label="NVIDIA T4", tier=GpuTier.STARTER,
         aws_instance_type="g4dn.4xlarge", gpu_count=1, vcpu=16, ram_gb=64, vram_gb=16,
         price_micros_per_hour=2_680_000, aws_cost_micros_per_hour=890_000,
         safe_infrastructure_cost_micros=890_000),
    dict(slug="t4-large", display_name="T4 Large", gpu_label="NVIDIA T4", tier=GpuTier.STARTER,
         aws_instance_type="g4dn.8xlarge", gpu_count=1, vcpu=32, ram_gb=128, vram_gb=16,
         price_micros_per_hour=4_800_000, aws_cost_micros_per_hour=1_610_000,
         safe_infrastructure_cost_micros=1_610_000),
    dict(slug="t4-4gpu", display_name="T4 4GPU", gpu_label="NVIDIA T4", tier=GpuTier.STARTER,
         aws_instance_type="g4dn.12xlarge", gpu_count=4, vcpu=48, ram_gb=192, vram_gb=64,
         price_micros_per_hour=8_680_000, aws_cost_micros_per_hour=2_900_000,
         safe_infrastructure_cost_micros=2_900_000),
    dict(slug="t4-xl", display_name="T4 XL", gpu_label="NVIDIA T4", tier=GpuTier.STARTER,
         aws_instance_type="g4dn.16xlarge", gpu_count=1, vcpu=64, ram_gb=256, vram_gb=16,
         price_micros_per_hour=9_620_000, aws_cost_micros_per_hour=3_230_000,
         safe_infrastructure_cost_micros=3_230_000),
    dict(slug="t4-8gpu", display_name="T4 8GPU", gpu_label="NVIDIA T4", tier=GpuTier.STARTER,
         aws_instance_type="g4dn.metal", gpu_count=8, vcpu=96, ram_gb=384, vram_gb=128,
         price_micros_per_hour=17_350_000, aws_cost_micros_per_hour=5_810_000,
         safe_infrastructure_cost_micros=5_810_000),
    # --- NVIDIA A10G — tier: STANDARD (8 SKUs) ---
    dict(slug="a10g-nano", display_name="A10G Nano", gpu_label="NVIDIA A10G", tier=GpuTier.STANDARD,
         aws_instance_type="g5.xlarge", gpu_count=1, vcpu=4, ram_gb=16, vram_gb=24,
         price_micros_per_hour=2_230_000, aws_cost_micros_per_hour=750_000,
         safe_infrastructure_cost_micros=750_000),
    dict(slug="a10g-small", display_name="A10G Small", gpu_label="NVIDIA A10G", tier=GpuTier.STANDARD,
         aws_instance_type="g5.2xlarge", gpu_count=1, vcpu=8, ram_gb=32, vram_gb=24,
         price_micros_per_hour=2_680_000, aws_cost_micros_per_hour=900_000,
         safe_infrastructure_cost_micros=900_000),
    dict(slug="a10g-medium", display_name="A10G Medium", gpu_label="NVIDIA A10G", tier=GpuTier.STANDARD,
         aws_instance_type="g5.4xlarge", gpu_count=1, vcpu=16, ram_gb=64, vram_gb=24,
         price_micros_per_hour=3_570_000, aws_cost_micros_per_hour=1_210_000,
         safe_infrastructure_cost_micros=1_210_000),
    dict(slug="a10g-large", display_name="A10G Large", gpu_label="NVIDIA A10G", tier=GpuTier.STANDARD,
         aws_instance_type="g5.8xlarge", gpu_count=1, vcpu=32, ram_gb=128, vram_gb=24,
         price_micros_per_hour=5_360_000, aws_cost_micros_per_hour=1_820_000,
         safe_infrastructure_cost_micros=1_820_000),
    dict(slug="a10g-4gpu", display_name="A10G 4GPU", gpu_label="NVIDIA A10G", tier=GpuTier.STANDARD,
         aws_instance_type="g5.12xlarge", gpu_count=4, vcpu=48, ram_gb=192, vram_gb=96,
         price_micros_per_hour=12_310_000, aws_cost_micros_per_hour=4_210_000,
         safe_infrastructure_cost_micros=4_210_000),
    dict(slug="a10g-xl", display_name="A10G XL", gpu_label="NVIDIA A10G", tier=GpuTier.STANDARD,
         aws_instance_type="g5.16xlarge", gpu_count=1, vcpu=64, ram_gb=256, vram_gb=24,
         price_micros_per_hour=8_950_000, aws_cost_micros_per_hour=3_040_000,
         safe_infrastructure_cost_micros=3_040_000),
    dict(slug="a10g-4gpu-xl", display_name="A10G 4GPU XL", gpu_label="NVIDIA A10G", tier=GpuTier.STANDARD,
         aws_instance_type="g5.24xlarge", gpu_count=4, vcpu=96, ram_gb=384, vram_gb=96,
         price_micros_per_hour=17_910_000, aws_cost_micros_per_hour=6_040_000,
         safe_infrastructure_cost_micros=6_040_000),
    dict(slug="a10g-8gpu", display_name="A10G 8GPU", gpu_label="NVIDIA A10G", tier=GpuTier.STANDARD,
         aws_instance_type="g5.48xlarge", gpu_count=8, vcpu=192, ram_gb=768, vram_gb=192,
         price_micros_per_hour=35_830_000, aws_cost_micros_per_hour=12_090_000,
         safe_infrastructure_cost_micros=12_090_000),
    # --- NVIDIA L4 — L4 Nano is STARTER, the rest STANDARD (8 SKUs) ---
    dict(slug="l4-nano", display_name="L4 Nano", gpu_label="NVIDIA L4", tier=GpuTier.STARTER,
         aws_instance_type="g6.xlarge", gpu_count=1, vcpu=4, ram_gb=16, vram_gb=24,
         price_micros_per_hour=1_780_000, aws_cost_micros_per_hour=600_000,
         safe_infrastructure_cost_micros=600_000),
    dict(slug="l4-small", display_name="L4 Small", gpu_label="NVIDIA L4", tier=GpuTier.STANDARD,
         aws_instance_type="g6.2xlarge", gpu_count=1, vcpu=8, ram_gb=32, vram_gb=24,
         price_micros_per_hour=2_170_000, aws_cost_micros_per_hour=730_000,
         safe_infrastructure_cost_micros=730_000),
    dict(slug="l4-medium", display_name="L4 Medium", gpu_label="NVIDIA L4", tier=GpuTier.STANDARD,
         aws_instance_type="g6.4xlarge", gpu_count=1, vcpu=16, ram_gb=64, vram_gb=24,
         price_micros_per_hour=2_930_000, aws_cost_micros_per_hour=980_000,
         safe_infrastructure_cost_micros=980_000),
    dict(slug="l4-large", display_name="L4 Large", gpu_label="NVIDIA L4", tier=GpuTier.STANDARD,
         aws_instance_type="g6.8xlarge", gpu_count=1, vcpu=32, ram_gb=128, vram_gb=24,
         price_micros_per_hour=4_470_000, aws_cost_micros_per_hour=1_490_000,
         safe_infrastructure_cost_micros=1_490_000),
    dict(slug="l4-4gpu", display_name="L4 4GPU", gpu_label="NVIDIA L4", tier=GpuTier.STANDARD,
         aws_instance_type="g6.12xlarge", gpu_count=4, vcpu=48, ram_gb=192, vram_gb=96,
         price_micros_per_hour=10_070_000, aws_cost_micros_per_hour=3_410_000,
         safe_infrastructure_cost_micros=3_410_000),
    dict(slug="l4-xl", display_name="L4 XL", gpu_label="NVIDIA L4", tier=GpuTier.STANDARD,
         aws_instance_type="g6.16xlarge", gpu_count=1, vcpu=64, ram_gb=256, vram_gb=24,
         price_micros_per_hour=7_270_000, aws_cost_micros_per_hour=2_520_000,
         safe_infrastructure_cost_micros=2_520_000),
    dict(slug="l4-4gpu-xl", display_name="L4 4GPU XL", gpu_label="NVIDIA L4", tier=GpuTier.STANDARD,
         aws_instance_type="g6.24xlarge", gpu_count=4, vcpu=96, ram_gb=384, vram_gb=96,
         price_micros_per_hour=14_550_000, aws_cost_micros_per_hour=4_950_000,
         safe_infrastructure_cost_micros=4_950_000),
    dict(slug="l4-8gpu", display_name="L4 8GPU", gpu_label="NVIDIA L4", tier=GpuTier.STANDARD,
         aws_instance_type="g6.48xlarge", gpu_count=8, vcpu=192, ram_gb=768, vram_gb=192,
         price_micros_per_hour=29_110_000, aws_cost_micros_per_hour=9_910_000,
         safe_infrastructure_cost_micros=9_910_000),
    # --- NVIDIA L40S — tier: PRO (8 SKUs) ---
    dict(slug="l40s-nano", display_name="L40S Nano", gpu_label="NVIDIA L40S", tier=GpuTier.PRO,
         aws_instance_type="g6e.xlarge", gpu_count=1, vcpu=4, ram_gb=32, vram_gb=48,
         price_micros_per_hour=4_130_000, aws_cost_micros_per_hour=1_380_000,
         safe_infrastructure_cost_micros=1_380_000),
    dict(slug="l40s-small", display_name="L40S Small", gpu_label="NVIDIA L40S", tier=GpuTier.PRO,
         aws_instance_type="g6e.2xlarge", gpu_count=1, vcpu=8, ram_gb=64, vram_gb=48,
         price_micros_per_hour=4_980_000, aws_cost_micros_per_hour=1_660_000,
         safe_infrastructure_cost_micros=1_660_000),
    dict(slug="l40s-medium", display_name="L40S Medium", gpu_label="NVIDIA L40S", tier=GpuTier.PRO,
         aws_instance_type="g6e.4xlarge", gpu_count=1, vcpu=16, ram_gb=128, vram_gb=48,
         price_micros_per_hour=6_660_000, aws_cost_micros_per_hour=2_230_000,
         safe_infrastructure_cost_micros=2_230_000),
    dict(slug="l40s-large", display_name="L40S Large", gpu_label="NVIDIA L40S", tier=GpuTier.PRO,
         aws_instance_type="g6e.8xlarge", gpu_count=1, vcpu=32, ram_gb=256, vram_gb=48,
         price_micros_per_hour=10_070_000, aws_cost_micros_per_hour=3_360_000,
         safe_infrastructure_cost_micros=3_360_000),
    dict(slug="l40s-xl", display_name="L40S XL", gpu_label="NVIDIA L40S", tier=GpuTier.PRO,
         aws_instance_type="g6e.16xlarge", gpu_count=1, vcpu=64, ram_gb=512, vram_gb=48,
         price_micros_per_hour=16_790_000, aws_cost_micros_per_hour=5_620_000,
         safe_infrastructure_cost_micros=5_620_000),
    dict(slug="l40s-4gpu", display_name="L40S 4GPU", gpu_label="NVIDIA L40S", tier=GpuTier.PRO,
         aws_instance_type="g6e.12xlarge", gpu_count=4, vcpu=48, ram_gb=384, vram_gb=192,
         price_micros_per_hour=23_510_000, aws_cost_micros_per_hour=7_790_000,
         safe_infrastructure_cost_micros=7_790_000),
    dict(slug="l40s-4gpu-xl", display_name="L40S 4GPU XL", gpu_label="NVIDIA L40S", tier=GpuTier.PRO,
         aws_instance_type="g6e.24xlarge", gpu_count=4, vcpu=96, ram_gb=768, vram_gb=192,
         price_micros_per_hour=33_590_000, aws_cost_micros_per_hour=11_180_000,
         safe_infrastructure_cost_micros=11_180_000),
    dict(slug="l40s-8gpu", display_name="L40S 8GPU", gpu_label="NVIDIA L40S", tier=GpuTier.PRO,
         aws_instance_type="g6e.48xlarge", gpu_count=8, vcpu=192, ram_gb=1536, vram_gb=384,
         price_micros_per_hour=67_190_000, aws_cost_micros_per_hour=22_360_000,
         safe_infrastructure_cost_micros=22_360_000),
    # --- NVIDIA A100 — tier: ULTRA (8-GPU configuration only, spec §10.5) ---
    dict(slug="a100-8gpu", display_name="A100 8GPU", gpu_label="NVIDIA A100", tier=GpuTier.ULTRA,
         aws_instance_type="p4d.24xlarge", gpu_count=8, vcpu=96, ram_gb=1152, vram_gb=320,
         price_micros_per_hour=48_720_000, aws_cost_micros_per_hour=16_290_000,
         safe_infrastructure_cost_micros=16_290_000),
    # --- NVIDIA H100 — tier: ULTRA (2 SKUs) ---
    dict(slug="h100-nano", display_name="H100 Nano", gpu_label="NVIDIA H100", tier=GpuTier.ULTRA,
         aws_instance_type="p5.4xlarge", gpu_count=1, vcpu=16, ram_gb=256, vram_gb=80,
         price_micros_per_hour=15_230_000, aws_cost_micros_per_hour=5_100_000,
         safe_infrastructure_cost_micros=5_100_000),
    dict(slug="h100-8gpu", display_name="H100 8GPU", gpu_label="NVIDIA H100", tier=GpuTier.ULTRA,
         aws_instance_type="p5.48xlarge", gpu_count=8, vcpu=192, ram_gb=2048, vram_gb=640,
         price_micros_per_hour=121_520_000, aws_cost_micros_per_hour=40_840_000,
         safe_infrastructure_cost_micros=40_840_000),
]

# The 4 rows the old 4-tier seed created. Renaming IN PLACE (not delete+insert)
# keeps gpu_instances FK history intact.
LEGACY_RENAMES = {
    "starter": "t4-nano",
    "standard": "a10g-nano",
    "performance": "a10g-small",
    "max": "a10g-medium",
}

# Persistent-storage catalogue — the product spec §7 storage pricing table.
# Hourly price is charged only for PAID sizes (a size equal to the plan's
# workspace_storage_gb is the plan entitlement and is never billed); the
# prepaid price is the one-off 30-day commitment. available_plans encodes the
# per-plan size matrix (Free: 50/100/250GB; Pro/Ultra: 500GB/1/2/5TB; Max:
# 1/2/5/10TB). All rows seed enabled=False: paid storage stays unpurchasable
# until real storage provisioning lands (Phase 3) — the same rollout switch
# as GPU SKUs. A plan's included size is always creatable regardless.
STORAGE_SIZE_DEFAULTS = [
    dict(size_gb=50, display_name="50 GB", hourly_price_micros=10_000,
         prepaid_price_micros=5_990_000, available_plans=["FREE"]),
    dict(size_gb=100, display_name="100 GB", hourly_price_micros=20_000,
         prepaid_price_micros=9_990_000, available_plans=["FREE"]),
    dict(size_gb=250, display_name="250 GB", hourly_price_micros=40_000,
         prepaid_price_micros=19_990_000, available_plans=["FREE"]),
    dict(size_gb=500, display_name="500 GB", hourly_price_micros=70_000,
         prepaid_price_micros=34_990_000, available_plans=["PRO", "ULTRA"]),
    dict(size_gb=1024, display_name="1 TB", hourly_price_micros=140_000,
         prepaid_price_micros=69_990_000, available_plans=["PRO", "ULTRA", "MAX"]),
    dict(size_gb=2048, display_name="2 TB", hourly_price_micros=270_000,
         prepaid_price_micros=134_990_000, available_plans=["PRO", "ULTRA", "MAX"]),
    dict(size_gb=5120, display_name="5 TB", hourly_price_micros=650_000,
         prepaid_price_micros=324_990_000, available_plans=["PRO", "ULTRA", "MAX"]),
    dict(size_gb=10240, display_name="10 TB", hourly_price_micros=1_250_000,
         prepaid_price_micros=624_990_000, available_plans=["MAX"]),
]

# Launch regions (spec §12). country_or_area drives the scheduler's location
# preference filter (§13): Automatic / UK / Europe / North America / Asia.
REGION_DEFAULTS = [
    dict(aws_region_code="us-east-1", public_name="US East (N. Virginia)", country_or_area="North America"),
    dict(aws_region_code="us-west-2", public_name="US West (Oregon)", country_or_area="North America"),
    dict(aws_region_code="eu-north-1", public_name="EU North (Stockholm)", country_or_area="Europe"),
    dict(aws_region_code="eu-west-2", public_name="UK London", country_or_area="UK"),
    dict(aws_region_code="eu-central-1", public_name="EU Central (Frankfurt)", country_or_area="Europe"),
    dict(aws_region_code="ap-northeast-1", public_name="Asia Pacific Tokyo", country_or_area="Asia"),
]

# Regional service premiums (spec §12) — 1-GPU family baselines, micro-GBP/hr.
# US East / US West are the baseline regions (always £0.00) and are therefore
# absent from the maps. None = the spec's "N/A": that configuration must NOT
# be offered in that region (§12), seeded as NOT_OFFERED.
_FAMILY_1GPU_PREMIUMS = {
    "T4": {"eu-north-1": 80_000, "eu-west-2": 220_000, "eu-central-1": 270_000, "ap-northeast-1": 280_000},
    "A10G": {"eu-north-1": 120_000, "eu-west-2": 560_000, "eu-central-1": 530_000, "ap-northeast-1": 690_000},
    "L4": {"eu-north-1": 80_000, "eu-west-2": 340_000, "eu-central-1": 310_000, "ap-northeast-1": 560_000},
    "L40S": {"eu-north-1": 170_000, "eu-west-2": None, "eu-central-1": 720_000, "ap-northeast-1": 1_290_000},
    "H100": {"eu-north-1": None, "eu-west-2": 3_170_000, "eu-central-1": None, "ap-northeast-1": 2_640_000},
}

# Configurations the spec prices per-CONFIGURATION rather than per 1-GPU
# family (§12: "Multi-GPU configurations should use exact per-configuration
# regional premiums in the backend rather than blindly multiplying the 1-GPU
# premium by GPU count").
_CONFIG_PREMIUMS = {
    ("A100", 8): {"eu-north-1": 2_690_000, "eu-west-2": 10_140_000, "eu-central-1": 8_400_000, "ap-northeast-1": 12_510_000},
    ("H100", 8): {"eu-north-1": 5_900_000, "eu-west-2": 25_360_000, "eu-central-1": None, "ap-northeast-1": 21_030_000},
}

# 1-GPU baseline AWS planning cost per family — the aws_cost_micros_per_hour
# of the family's cheapest 1-GPU SKU. The denominator used to scale unlisted
# multi-GPU configurations (see _region_premium_micros below).
_FAMILY_1GPU_BASE_COST = {"T4": 390_000, "A10G": 750_000, "L4": 600_000, "L40S": 1_380_000, "H100": 5_100_000}


def _region_premium_micros(family: str, gpu_count: int, region_code: str, sku_aws_cost_micros: int):
    """
    The customer-facing regional premium for one (SKU x region) configuration,
    in micro-GBP/hour — or None when the spec marks it N/A (NOT_OFFERED).

    - Configurations listed per-configuration in §12 (A100 8GPU, H100 8GPU)
      use the spec's exact numbers.
    - 1-GPU SKUs use their family's baseline premium directly.
    - Unlisted multi-GPU configurations scale the family's 1-GPU premium by
      how much infrastructure the configuration actually consumes relative to
      the family's 1-GPU baseline (sku AWS cost / baseline cost), rounded to
      the nearest £0.01. This honours §12's "exact per-configuration
      premiums, not blind multiplication by GPU count" while giving every
      launch catalogue row a defensible, documented price.
    """
    if region_code in ("us-east-1", "us-west-2"):
        # Baseline regions (§12): every configuration is offered at £0.00
        # premium, whatever its size.
        return 0
    config_premiums = _CONFIG_PREMIUMS.get((family, gpu_count))
    if config_premiums is not None:
        return config_premiums.get(region_code, 0)
    if gpu_count == 1:
        return _FAMILY_1GPU_PREMIUMS.get(family, {}).get(region_code, 0)
    one_gpu_premium = _FAMILY_1GPU_PREMIUMS.get(family, {}).get(region_code)
    if one_gpu_premium is None:
        return None  # N/A family-region -> not offered for any configuration
    baseline = _FAMILY_1GPU_BASE_COST.get(family)
    if baseline is None or baseline <= 0:
        return one_gpu_premium
    scale = sku_aws_cost_micros / baseline
    return round(one_gpu_premium * scale / 10_000) * 10_000

PROVIDER_DEFAULTS = [
    (ProviderKind.NVIDIA, "NVIDIA"),
    (ProviderKind.MOONSHOT, "Moonshot"),
    (ProviderKind.OPENROUTER, "OpenRouter"),
]

# Example catalog entries — real model_identifier strings for each provider's
# own API. Enabled only when the provider is actually configured. The AI
# gateway is OUT OF SCOPE for launch (spec §1) but stays seeded and dormant.
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
        entitled_plans=[PlanCode.PRO, PlanCode.ULTRA, PlanCode.MAX],
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
        entitled_plans=[PlanCode.FREE, PlanCode.PRO, PlanCode.ULTRA, PlanCode.MAX],
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
                print(
                    f"Plan {defaults['code'].value}: updated -> "
                    f"price={defaults['monthly_price_micros']} credits={defaults['monthly_credit_micros']}"
                )
            else:
                db.add(Plan(**defaults))
                print(f"Plan {defaults['code'].value}: created")
        db.commit()

        for defaults in STORAGE_SIZE_DEFAULTS:
            existing = db.execute(
                select(StorageSize).where(StorageSize.size_gb == defaults["size_gb"])
            ).scalar_one_or_none()
            if existing:
                for k, v in defaults.items():
                    setattr(existing, k, v)
            else:
                db.add(StorageSize(enabled=False, **defaults))
        db.commit()

        settings = get_settings()
        rows_by_slug = {r.slug: r for r in db.execute(select(GpuType)).scalars()}
        legacy_to_row = {old: rows_by_slug[old] for old in LEGACY_RENAMES if old in rows_by_slug}
        inserted = 0
        for defaults in GPU_TYPE_DEFAULTS:
            row = rows_by_slug.get(defaults["slug"])
            if row is None:
                # No row with the target slug — adopt the legacy row it
                # replaces (renaming in place preserves rental FK history).
                legacy_slug = next((old for old, new in LEGACY_RENAMES.items() if new == defaults["slug"]), None)
                row = legacy_to_row.get(legacy_slug)
                if row is not None:
                    legacy_to_row.pop(legacy_slug)
            if row is None:
                db.add(
                    GpuType(
                        aws_region=settings.aws_region,
                        ami_id=None,  # never fabricate an AMI — Phase 3 resolves via SSM
                        enabled=False,  # switched on deliberately, per SKU, after AMI resolution
                        max_runtime_hours=None,  # use the platform default cap
                        minimum_rental_hours=1,  # spec §20: 1-hour minimum at launch
                        **defaults,
                    )
                )
                inserted += 1
            else:
                for k, v in defaults.items():
                    setattr(row, k, v)
                # Never leave a rentable SKU without a resolved real AMI.
                if row.ami_id is None:
                    row.enabled = False
        db.commit()

        # --- Launch regions + the (SKU x region) premium matrix (§12, §19) ---
        region_rows: dict[str, Region] = {}
        for defaults in REGION_DEFAULTS:
            existing = db.execute(
                select(Region).where(Region.aws_region_code == defaults["aws_region_code"])
            ).scalar_one_or_none()
            if existing:
                for k, v in defaults.items():
                    setattr(existing, k, v)
                region_rows[existing.aws_region_code] = existing
            else:
                region = Region(status=RegionStatus.AVAILABLE, **defaults)
                db.add(region)
                db.flush()
                region_rows[region.aws_region_code] = region
        db.commit()

        sku_rows = list(db.execute(select(GpuType)).scalars())
        available_rows = 0
        not_offered_rows = 0
        for sku in sku_rows:
            family = sku.gpu_label.replace("NVIDIA ", "")
            for code in (r["aws_region_code"] for r in REGION_DEFAULTS):
                region = region_rows[code]
                premium = _region_premium_micros(family, sku.gpu_count, code, sku.aws_cost_micros_per_hour)
                row = db.execute(
                    select(GpuRegionAvailability).where(
                        GpuRegionAvailability.gpu_type_id == sku.id,
                        GpuRegionAvailability.region_id == region.id,
                    )
                ).scalar_one_or_none()
                if premium is None:
                    # §12: an N/A region must never be offered for this
                    # configuration. A previously-cached AMI on a flipped row
                    # is harmless (the scheduler only reads AVAILABLE rows)
                    # and is deliberately left in place for auditability.
                    if row is None:
                        db.add(
                            GpuRegionAvailability(
                                gpu_type_id=sku.id,
                                region_id=region.id,
                                status=GpuRegionStatus.NOT_OFFERED,
                                premium_micros=0,
                                aws_cost_est_micros_per_hour=0,
                            )
                        )
                    else:
                        row.status = GpuRegionStatus.NOT_OFFERED
                        row.premium_micros = 0
                        row.aws_cost_est_micros_per_hour = 0
                    not_offered_rows += 1
                    continue
                if row is None:
                    db.add(
                        GpuRegionAvailability(
                            gpu_type_id=sku.id,
                            region_id=region.id,
                            status=GpuRegionStatus.AVAILABLE,
                            premium_micros=premium,
                            # Launch-time regional planning cost (§19 input):
                            # baseline SKU cost + premium. The premium is
                            # exactly what covers regional economics until
                            # live regional telemetry exists (the AWS pricing
                            # API needs pricing:GetProducts, not yet granted).
                            aws_cost_est_micros_per_hour=sku.aws_cost_micros_per_hour + premium,
                        )
                    )
                else:
                    row.status = GpuRegionStatus.AVAILABLE
                    row.premium_micros = premium
                    row.aws_cost_est_micros_per_hour = sku.aws_cost_micros_per_hour + premium
                available_rows += 1
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
        total = len(GPU_TYPE_DEFAULTS)
        plans_now = {p.code.value: (p.monthly_price_micros, p.monthly_credit_micros) for p in db.execute(select(Plan)).scalars()}
        print("Seed complete.")
        print(f"Plans in DB now: {plans_now}")
        print(f"GPU catalogue: {total} SKUs seeded ({inserted} new, {total - inserted} updated in place), all enabled=False until a regional AMI is resolved.")
        print(f"Regions: {len(region_rows)} launch regions seeded; regional matrix: {available_rows} offered + {not_offered_rows} N/A configurations.")
        print(f"Storage catalogue: {len(STORAGE_SIZE_DEFAULTS)} sizes seeded, all enabled=False until storage provisioning lands.")
        print(f"Configured providers: {sorted(configured) or '(none - set provider API keys in .env)'}")

        # Best-effort copy sync: keep live Stripe product descriptions
        # matching the checkout copy defined in code, so every checkout page
        # describes what the buyer is purchasing. No-op when Stripe isn't
        # configured (local dev); never fails the build over marketing copy.
        try:
            from scripts.sync_stripe_product_descriptions import sync_product_descriptions

            updated = sync_product_descriptions(strict=False)
            if updated:
                print(f"Stripe product descriptions: {updated} updated.")
        except Exception:  # noqa: BLE001 — never break seeding over checkout copy
            print("Stripe product description sync skipped (Stripe not configured here).")
    finally:
        db.close()


if __name__ == "__main__":
    run()
