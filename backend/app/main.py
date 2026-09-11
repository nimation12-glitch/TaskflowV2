from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    api_keys,
    billing,
    gateway,
    gpu_catalog,
    internal,
    models_catalog,
    organizations,
    rentals,
    ssh_keys,
    team,
    usage,
    wallet,
    webhooks,
)
from app.config import get_settings, validate_production_config

logging.basicConfig(level=logging.INFO)
settings = get_settings()

# Hard startup gate — see app/config.py. No simulated fallback exists.
validate_production_config(settings)

app = FastAPI(
    title="TaskFlow API",
    version="0.1.0",
    description="TaskFlow control plane: organizations, billing, API keys, and the AI gateway.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(internal.router)
app.include_router(internal.gpu_sweep_router)
app.include_router(organizations.router)
app.include_router(api_keys.router)
app.include_router(team.router)
app.include_router(billing.router)
app.include_router(usage.router)
app.include_router(models_catalog.router)
app.include_router(webhooks.router)
app.include_router(gateway.router)
app.include_router(gpu_catalog.router)
app.include_router(wallet.router)
app.include_router(ssh_keys.router)
app.include_router(rentals.router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "environment": settings.environment,
        "stripe_configured": settings.stripe_configured,
        "google_oauth_configured": settings.google_configured,
        "microsoft_oauth_configured": settings.microsoft_configured,
        "github_oauth_configured": settings.github_configured,
    }
