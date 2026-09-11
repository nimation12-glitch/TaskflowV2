"""
Central configuration for TaskFlow.

CRITICAL RULE (see docs/AGENTS.md §46 / billing spec §14):
In production, the application MUST refuse to start if required secrets
are missing. There is no simulated/fake fallback for billing, auth, or
provider credentials, ever.
"""
from __future__ import annotations

import sys
from functools import lru_cache
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"

    cors_origins: str = "http://localhost:3000"
    api_base_url: str = "http://localhost:8000"
    app_base_url: str = "http://localhost:3000"

    database_url: str = "postgresql+psycopg2://taskflow:taskflow@localhost:5432/taskflow"

    auth_secret: str = ""
    taskflow_api_key_pepper: str = ""
    # Separate secret used only for pre-session, server-to-server calls from
    # the Next.js backend (e.g. bootstrapping a brand-new user's organization,
    # where no org/role JWT exists yet). Never exposed to the browser.
    backend_service_secret: str = ""

    stripe_secret_key: str = ""
    stripe_publishable_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_pro: str = ""
    stripe_price_max: str = ""
    stripe_price_credit_10: str = ""
    stripe_price_credit_25: str = ""
    stripe_price_credit_50: str = ""
    stripe_price_credit_100: str = ""

    google_client_id: str = ""
    google_client_secret: str = ""

    microsoft_client_id: str = ""
    microsoft_client_secret: str = ""
    microsoft_tenant_id: str = "common"

    github_client_id: str = ""
    github_client_secret: str = ""

    email_provider: str = "console"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from_email: str = "no-reply@taskflow.web-agent.org"

    nvidia_api_key: str = ""
    nvidia_api_base: str = "https://integrate.api.nvidia.com/v1"
    moonshot_api_key: str = ""
    moonshot_api_base: str = "https://api.moonshot.ai/v1"
    openrouter_api_key: str = ""
    openrouter_api_base: str = "https://openrouter.ai/api/v1"

    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_region: str = "eu-west-2"

    # Separate secret protecting POST /internal/gpu/sweep, called by an
    # external cron every few minutes. Deliberately distinct from
    # BACKEND_SERVICE_SECRET so this endpoint isn't reachable via that
    # more broadly-used secret — see app/api/internal.py.
    gpu_sweep_service_secret: str = ""
    gpu_max_runtime_hours_default: int = 48
    gpu_provisioning_timeout_minutes: int = 10

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def stripe_configured(self) -> bool:
        return bool(self.stripe_secret_key and self.stripe_webhook_secret)

    @property
    def google_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def microsoft_configured(self) -> bool:
        return bool(self.microsoft_client_id and self.microsoft_client_secret)

    @property
    def github_configured(self) -> bool:
        return bool(self.github_client_id and self.github_client_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()


def validate_production_config(settings: Settings) -> None:
    """
    Fail fast and loud if production is missing anything required.
    This is intentionally strict — see docs/AGENTS.md.
    """
    if not settings.is_production:
        return

    missing: list[str] = []

    if not settings.auth_secret or len(settings.auth_secret) < 32:
        missing.append("AUTH_SECRET (must be a long random string)")
    if not settings.taskflow_api_key_pepper or len(settings.taskflow_api_key_pepper) < 32:
        missing.append("TASKFLOW_API_KEY_PEPPER (must be a long random string)")
    if not settings.backend_service_secret or len(settings.backend_service_secret) < 32:
        missing.append("BACKEND_SERVICE_SECRET (must be a long random string)")

    # Stripe is required in production — billing must never fall back to fakes.
    if not settings.stripe_secret_key:
        missing.append("STRIPE_SECRET_KEY")
    if not settings.stripe_webhook_secret:
        missing.append("STRIPE_WEBHOOK_SECRET")
    if not settings.stripe_price_pro:
        missing.append("STRIPE_PRICE_PRO")
    if not settings.stripe_price_max:
        missing.append("STRIPE_PRICE_MAX")

    # AWS/GPU rental — no simulated provisioning fallback exists, so the app
    # must refuse to start rather than silently pretend GPU rental works.
    if not settings.aws_access_key_id:
        missing.append("AWS_ACCESS_KEY_ID")
    if not settings.aws_secret_access_key:
        missing.append("AWS_SECRET_ACCESS_KEY")
    if not settings.gpu_sweep_service_secret or len(settings.gpu_sweep_service_secret) < 32:
        missing.append("GPU_SWEEP_SERVICE_SECRET (must be a long random string)")

    if settings.email_provider == "console":
        missing.append("EMAIL_PROVIDER must not be 'console' in production (set 'smtp' and SMTP_* vars)")

    if missing:
        joined = "\n  - ".join(missing)
        print(
            "FATAL: TaskFlow refuses to start in production with missing/invalid "
            f"configuration:\n  - {joined}\n"
            "No simulated fallback exists for these values by design.",
            file=sys.stderr,
        )
        raise SystemExit(1)
