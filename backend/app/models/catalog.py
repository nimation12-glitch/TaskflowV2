from __future__ import annotations

import enum
import uuid
from typing import Optional

from sqlalchemy import BigInteger, Boolean, Enum, ForeignKey, Integer, String, JSON
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.base import TimestampMixin, UUIDPKMixin
from app.models.billing import PlanCode


class ProviderKind(str, enum.Enum):
    NVIDIA = "NVIDIA"
    MOONSHOT = "MOONSHOT"
    OPENROUTER = "OPENROUTER"
    TASKFLOW_HOSTED = "TASKFLOW_HOSTED"


class Provider(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "providers"

    kind: Mapped[ProviderKind] = mapped_column(Enum(ProviderKind), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    # Whether required env credentials are present — computed at startup, not stored,
    # but we keep a cached flag so the models list can be filtered without re-checking env
    # on every request.
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    models: Mapped[list["AiModel"]] = relationship(back_populates="provider")


class HostingMode(str, enum.Enum):
    EXTERNAL_API = "EXTERNAL_API"
    TASKFLOW_HOSTED = "TASKFLOW_HOSTED"
    CUSTOMER_HOSTED = "CUSTOMER_HOSTED"


class ModelStatus(str, enum.Enum):
    LIVE = "LIVE"
    COMING_SOON = "COMING_SOON"
    DISABLED = "DISABLED"
    NOT_CONFIGURED = "NOT_CONFIGURED"
    DEMO_ONLY = "DEMO_ONLY"


class AiModel(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "ai_models"

    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(150), nullable=False)
    version: Mapped[str] = mapped_column(String(50), nullable=False)
    provider_id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("providers.id"), nullable=False)
    model_identifier: Mapped[str] = mapped_column(String(200), nullable=False)  # id used in provider's own API
    hosting_mode: Mapped[HostingMode] = mapped_column(Enum(HostingMode), nullable=False)

    source: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    source_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    license: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    commercial_use_reviewed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    runtime: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    minimum_vram_gb: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    capabilities: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)  # e.g. {"chat": true, "vision": false}
    context_window: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[ModelStatus] = mapped_column(Enum(ModelStatus), default=ModelStatus.NOT_CONFIGURED, nullable=False)

    provider: Mapped["Provider"] = relationship(back_populates="models")
    entitlements: Mapped[list["ModelEntitlement"]] = relationship(back_populates="model", cascade="all, delete-orphan")
    pricing: Mapped[list["ModelPricing"]] = relationship(back_populates="model", cascade="all, delete-orphan")


class ModelEntitlement(UUIDPKMixin, Base):
    """Which plans may access a given model. Server is authoritative — never trust the frontend."""

    __tablename__ = "model_entitlements"

    id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    model_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("ai_models.id", ondelete="CASCADE"), nullable=False, index=True
    )
    plan_code: Mapped[PlanCode] = mapped_column(Enum(PlanCode), nullable=False)

    model: Mapped["AiModel"] = relationship(back_populates="entitlements")


class ModelPricing(UUIDPKMixin, TimestampMixin, Base):
    """
    Pricing is entirely data-driven — never hardcoded in request handlers.
    All monetary fields are integer micro-GBP per unit.
    """

    __tablename__ = "model_pricing"

    model_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("ai_models.id", ondelete="CASCADE"), nullable=False, index=True
    )
    input_token_price_micros_per_1k: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    output_token_price_micros_per_1k: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    gpu_price_micros_per_second: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    margin_bps: Mapped[int] = mapped_column(Integer, default=1500, nullable=False)  # basis points, e.g. 1500 = 15%
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    model: Mapped["AiModel"] = relationship(back_populates="pricing")
