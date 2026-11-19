"""
Regional AMI resolution via AWS (spec §15).

AMI ids are regional and must never be copied blindly between regions, so the
platform resolves a compatible Deep Learning AMI per region at launch time.

Two REAL resolution paths exist — no simulated fallback is ever used:

1. SSM Parameter Store (primary, cheapest): the public Deep Learning AMI
   parameter for the default image:

       /aws/service/deeplearning/ami/x86_64/oss-nvidia-driver-gpu-pytorch-2.13-amazon-linux-2023/latest/ami-id

2. ec2:DescribeImages by AWS's own AMI name pattern (fallback): used when the
   SSM parameter is denied, missing or carries no value. It queries the same
   public Amazon-owned images and picks the newest available one matching the
   pattern, so the result equals what SSM returns for the default image
   (verified live: both paths return e.g. ami-0c5b826f8aef571fc in eu-west-2).

Both paths hit real AWS APIs; if BOTH fail, AmiResolutionError is raised and
the scheduler treats the region as not viable rather than launching on a
guessed AMI.

The resolved default-image id is cached on the GpuRegionAvailability row
(ami_id + ami_resolved_at) with a TTL, so a busy scheduler does not hit AWS on
every launch, but a stale id also never lives longer than the TTL. Custom
workspace images are resolved live per launch (they are per-workspace, not
per-region state) — one extra read-only API call on a rare event.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models.region import GpuRegionAvailability

# The x86_64 Amazon Linux 2023 variant of the Deep Learning OSS Nvidia Driver
# AMI GPU PyTorch 2.13 (spec §15 primary GPU AMI).
AMI_SSM_PATH = (
    "/aws/service/deeplearning/ami/x86_64/"
    "oss-nvidia-driver-gpu-pytorch-2.13-amazon-linux-2023/latest/ami-id"
)

# Human-readable name for the catalogue's machine-image panel — kept next to
# the SSM path so the two can never drift apart.
AMI_DISPLAY_NAME = "AWS Deep Learning AMI · PyTorch 2.13 · Amazon Linux 2023 (x86_64)"

# DescribeImages name pattern for the default image. AWS filter values support
# '*' wildcards; the pattern is deliberately specific (framework version +
# OS + x86_64) so ARM64/Neuron images can never match it.
AMI_NAME_PATTERN = "Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.13 (Amazon Linux 2023)*"

# How long a cached AMI id stays trusted before the next launch re-resolves it.
AMI_CACHE_TTL = timedelta(hours=24)


class AmiResolutionError(Exception):
    """Neither SSM nor DescribeImages could resolve the regional AMI."""


def _credentials():
    settings = get_settings()
    if not settings.aws_access_key_id or not settings.aws_secret_access_key:
        raise AmiResolutionError("AWS credentials are not configured — cannot resolve the regional AMI")
    return settings


def _ssm_client(region_name: str):
    settings = _credentials()
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


def _ec2_client(region_name: str):
    settings = _credentials()
    try:
        import boto3
    except ImportError as exc:  # pragma: no cover - packaging error, not a runtime state
        raise AmiResolutionError("boto3 is not installed") from exc

    return boto3.client(
        "ec2",
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


def resolve_ami_from_ssm(region_name: str, ssm_parameter: str = AMI_SSM_PATH) -> str:
    """One real SSM GetParameter call in the target region. Raises AmiResolutionError on failure."""
    client = _ssm_client(region_name)
    try:
        response = client.get_parameter(Name=ssm_parameter)
    except Exception as exc:
        raise AmiResolutionError(
            f"Failed to resolve the regional GPU AMI via SSM in '{region_name}': {exc}"
        ) from exc
    value = (response.get("Parameter") or {}).get("Value")
    if not value:
        raise AmiResolutionError(f"SSM parameter '{ssm_parameter}' has no value in '{region_name}'")
    return value


def resolve_ami_from_describe_images(region_name: str, name_pattern: str = AMI_NAME_PATTERN) -> str:
    """
    Fallback path: ec2:DescribeImages over Amazon-owned images matching the
    AMI name pattern, newest build first. This is what makes launches work
    when ssm:GetParameter is not granted — same public images, same result.
    """
    client = _ec2_client(region_name)
    try:
        response = client.describe_images(
            Owners=["amazon"],
            Filters=[{"Name": "name", "Values": [name_pattern]}],
        )
    except Exception as exc:
        raise AmiResolutionError(
            f"Failed to resolve the regional GPU AMI via DescribeImages in '{region_name}': {exc}"
        ) from exc

    # State is filtered client-side (rather than by filter name) so a filter
    # typo can never silently return a deprecated/failed image.
    images = [img for img in response.get("Images", []) if img.get("State") == "available"]
    if not images:
        raise AmiResolutionError(
            f"No available Amazon-owned AMI matches '{name_pattern}' in '{region_name}'"
        )
    images.sort(key=lambda img: img.get("CreationDate") or "", reverse=True)
    return images[0]["ImageId"]


def resolve_ami(
    region_name: str,
    *,
    name_pattern: Optional[str] = None,
    ssm_parameter: Optional[str] = None,
) -> str:
    """
    Resolve a regional AMI id: SSM when a parameter applies (the default
    image, or an image that declares its own public parameter), otherwise —
    or on any SSM failure — the DescribeImages name-pattern path.
    """
    pattern = name_pattern or AMI_NAME_PATTERN
    parameter = ssm_parameter if ssm_parameter is not None else (
        AMI_SSM_PATH if pattern == AMI_NAME_PATTERN else None
    )

    if parameter is not None:
        try:
            return resolve_ami_from_ssm(region_name, parameter)
        except AmiResolutionError:
            # SSM denied/absent — fall through to DescribeImages, which needs
            # only ec2:DescribeImages (granted everywhere we launch).
            pass

    return resolve_ami_from_describe_images(region_name, pattern)


def get_or_resolve_ami(
    db: Session,
    availability: GpuRegionAvailability,
    *,
    force_refresh: bool = False,
    name_pattern: Optional[str] = None,
    ssm_parameter: Optional[str] = None,
) -> str:
    """
    Returns a current AMI id for the availability row's region.

    The default image uses the row-level cache (ami_id + ami_resolved_at,
    TTL'd). A custom workspace image is per-workspace state, not per-region
    state, so it is resolved live on every call and never written to the row
    (one image's id must never be served to another image's launch).
    Commits are left to the caller (same rule as the rest of the services).
    """
    region_name = availability.region.aws_region_code
    now = datetime.now(timezone.utc)
    is_default_image = (
        (name_pattern is None or name_pattern == AMI_NAME_PATTERN)
        and (ssm_parameter is None or ssm_parameter == AMI_SSM_PATH)
    )

    if is_default_image:
        if not force_refresh and _is_fresh(availability, now):
            return availability.ami_id
        ami = resolve_ami(region_name, name_pattern=name_pattern, ssm_parameter=ssm_parameter)
        availability.ami_id = ami
        availability.ami_resolved_at = now
        db.flush()
        return ami

    return resolve_ami(region_name, name_pattern=name_pattern, ssm_parameter=ssm_parameter)
