from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class UsageEventStatus(str, enum.Enum):
    SUCCESS = "SUCCESS"
    PROVIDER_ERROR = "PROVIDER_ERROR"      # dispatched but provider failed — not charged as success
    REJECTED = "REJECTED"                  # never dispatched (entitlement/rate-limit/credit failure) — never charged


class UsageEvent(UUIDPKMixin, Base):
    __tablename__ = "usage_events"

    id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(PGUUID(as_uuid=True), nullable=True)
    api_key_id: Mapped[Optional[uuid.UUID]] = mapped_column(PGUUID(as_uuid=True), nullable=True)
    model_id: Mapped[Optional[uuid.UUID]] = mapped_column(PGUUID(as_uuid=True), nullable=True)
    provider_id: Mapped[Optional[uuid.UUID]] = mapped_column(PGUUID(as_uuid=True), nullable=True)
    deployment_id: Mapped[Optional[uuid.UUID]] = mapped_column(PGUUID(as_uuid=True), nullable=True)

    status: Mapped[UsageEventStatus] = mapped_column(Enum(UsageEventStatus), nullable=False)

    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    gpu_seconds: Mapped[float] = mapped_column(BigInteger, default=0, nullable=False)  # stored *1000 (ms) as int

    provider_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    gpu_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    infrastructure_cost_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    margin_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    charge_micros: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    latency_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    error_detail: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
