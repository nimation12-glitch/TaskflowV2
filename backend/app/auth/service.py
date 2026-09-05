from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from app.config import get_settings


def require_service_secret(x_taskflow_service_secret: str | None = Header(default=None)) -> None:
    settings = get_settings()
    if not settings.backend_service_secret:
        raise HTTPException(status_code=500, detail="Backend service secret is not configured")
    if not x_taskflow_service_secret or not hmac.compare_digest(
        x_taskflow_service_secret, settings.backend_service_secret
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service credentials")
