"""
Regional AMI resolution via AWS Systems Manager Parameter Store (spec §15).

AMI ids are regional and must never be copied blindly between regions, so the
platform resolves the compatible Deep Learning AMI per region at launch time
through the public SSM parameter:

    /aws/service/deeplearning/ami/x86_64/oss-nvidia-driver-gpu-pytorch-2.13-amazon-linux-2023/latest/ami-id

The resolved id is cached on the GpuRegionAvailability row (ami_id +
ami_resolved_at) with a TTL, so a busy scheduler does not hit SSM on every
launch, but a stale id also never lives longer than the TTL.

No simulated fallback exists: if SSM cannot be reached or denies access, this
raises a typed error and the caller (the scheduler) treats the region as not
viable rather than launching on a guessed AMI.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.region import GpuRegionAvailability

# The x86_64 Amazon Linux 2023 variant of the Deep Learning OSS Nvidia Driver
# AMI GPU PyTorch 2.13 (spec §15 primary GPU AMI).
AMI_SSM_PATH = (
    "/aws/service/deeplearning/ami/x86_64/"
    "oss-nvidia-driver-gpu-pytorch-2.13-amazon-linux-2023/latest/ami-id"
)

# How long a cached AMI id stays trusted before the next launch re-resolves it.
AMI_CACHE_TTL = timedelta(hours=24)


class AmiResolutionError(Exception):
    """SSM could not resolve the regional AMI (missing permission, network, bad region...)."""


def _ssm_client(region_name: str):
    settings = get_settings()
    if not settings.aws_access_key_id or not settings.aws_secret_access_key:
        raise AmiResolutionError("AWS credentials are not configured — cannot resolve the regional AMI")
    try:
        import boto3
    except ImportError as exc:  # pragma: no cover - packaging error, not a runtime state
        raise AmiResolutionError("boto3 is not installed") from exc

    return boto3.client(
        "ssm",
        region_name=region_name,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
    )


def _is_fresh(availability: GpuRegionAvailability, now: datetime) -> bool:
    if not availability.ami_id or availability.ami_resolved_at is None:
        return False
    resolved = availability.ami_resolved_at
    if resolved.tzinfo is None:  # SQLite drops tzinfo — normalize defensively
        resolved = resolved.replace(tzinfo=timezone.utc)
    return (now - resolved) < AMI_CACHE_TTL


def resolve_ami_from_ssm(region_name: str) -> str:
    """One real SSM GetParameter call in the target region. Raises AmiResolutionError on failure."""
    client = _ssm_client(region_name)
    try:
        response = client.get_parameter(Name=AMI_SSM_PATH)
    except Exception as exc:
        raise AmiResolutionError(
            f"Failed to resolve the regional GPU AMI via SSM in '{region_name}': {exc}"
        ) from exc
    value = (response.get("Parameter") or {}).get("Value")
    if not value:
        raise AmiResolutionError(f"SSM parameter '{AMI_SSM_PATH}' has no value in '{region_name}'")
    return value


def get_or_resolve_ami(
    db: Session, availability: GpuRegionAvailability, *, force_refresh: bool = False
) -> str:
    """
    Returns a current AMI id for the availability row's region, resolving via
    SSM and caching onto the row when the cached copy is missing or stale.
    Commits are left to the caller (same rule as the rest of the services).
    """
    region_name = availability.region.aws_region_code
    now = datetime.now(timezone.utc)

    if not force_refresh and _is_fresh(availability, now):
        return availability.ami_id

    ami = resolve_ami_from_ssm(region_name)
    availability.ami_id = ami
    availability.ami_resolved_at = now
    db.flush()
    return ami
