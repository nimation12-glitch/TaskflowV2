from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.base import UUIDPKMixin


class SystemSetting(UUIDPKMixin, Base):
    """
    Deliberately a tiny singleton — exactly one row ever exists. This is
    enforced in the service layer (see app/services/system.py::get_or_create_settings),
    not a DB constraint — simplicity over cleverness for a table this small.
    """

    __tablename__ = "system_settings"

    maintenance_mode_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    maintenance_message: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    updated_by_user_id: Mapped[Optional[uuid.UUID]] = mapped_column(PGUUID(as_uuid=True), nullable=True)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
