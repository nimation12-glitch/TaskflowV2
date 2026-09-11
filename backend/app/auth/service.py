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


def require_gpu_sweep_secret(x_taskflow_service_secret: str | None = Header(default=None)) -> None:
    """
    Deliberately a separate secret from require_service_secret above, so the
    GPU safety sweep endpoint isn't reachable via the more broadly-used
    BACKEND_SERVICE_SECRET. See POST /internal/gpu/sweep.
    """
    settings = get_settings()
    if not settings.gpu_sweep_service_secret:
        raise HTTPException(status_code=500, detail="GPU sweep service secret is not configured")
    if not x_taskflow_service_secret or not hmac.compare_digest(
        x_taskflow_service_secret, settings.gpu_sweep_service_secret
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid service credentials")
