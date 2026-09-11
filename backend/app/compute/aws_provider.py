"""
Real AWS EC2 calls for GPU rental provisioning. No simulated fallback exists
anywhere in this module — if AWS credentials are missing/invalid, or any EC2
API call fails, every function here raises a typed exception rather than
pretending an instance is running when it isn't. This mirrors the same
discipline as app/billing/stripe_service.py.

Required IAM policy (least privilege, scoped to the configured region only —
see infra/aws-iam-policy.json for a ready-to-attach JSON document):
  ec2:RunInstances, ec2:StopInstances, ec2:StartInstances,
  ec2:TerminateInstances, ec2:DescribeInstances, ec2:DescribeImages,
  ec2:CreateTags, ec2:ImportKeyPair, ec2:DeleteKeyPair

Do NOT attach broader EC2 permissions than this list.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.config import get_settings
from app.models.compute import GpuType


class AwsProviderError(Exception):
    """Base class for every error this module raises. Never caught-and-ignored silently by callers."""


class AwsNotConfiguredError(AwsProviderError):
    """AWS credentials are not set. TaskFlow does not simulate AWS provisioning."""


class AwsRequestError(AwsProviderError):
    """A real AWS API call failed. Wraps the underlying botocore error for logging."""

    def __init__(self, message: str, *, aws_error_code: Optional[str] = None):
        super().__init__(message)
        self.aws_error_code = aws_error_code


class AwsInstanceStateError(AwsRequestError):
    """
    The instance is not currently in a state that supports the requested
    operation (e.g. trying to start an instance that is still stopping).
    Callers should surface this as a "try again shortly" error to the user,
    never retry-loop silently and never fabricate a state change.
    """


@dataclass
class InstanceStatus:
    state: str  # AWS's own state string: pending/running/stopping/stopped/shutting-down/terminated
    public_ip: Optional[str]


def _client():
    """
    Lazily constructs a boto3 EC2 client. Imported inside the function (not at
    module load) so environments without boto3/AWS configured can still import
    this module (e.g. for type references) without crashing at import time —
    the actual AWS call is what must fail loudly, not the import.
    """
    settings = get_settings()
    if not settings.aws_access_key_id or not settings.aws_secret_access_key:
        raise AwsNotConfiguredError(
            "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are not set. TaskFlow does not "
            "simulate GPU provisioning — configure real AWS credentials to enable this."
        )
    try:
        import boto3
    except ImportError as exc:  # pragma: no cover - packaging error, not a runtime state
        raise AwsProviderError("boto3 is not installed") from exc

    return boto3.client(
        "ec2",
        region_name=settings.aws_region,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
    )


def _wrap_client_error(exc: Exception, context: str) -> AwsRequestError:
    from botocore.exceptions import ClientError

    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
        message = exc.response.get("Error", {}).get("Message", str(exc))
        if code in ("IncorrectInstanceState", "IncorrectState"):
            return AwsInstanceStateError(f"{context}: {message}", aws_error_code=code)
        return AwsRequestError(f"{context}: {message}", aws_error_code=code)
    return AwsRequestError(f"{context}: {exc}")


def import_ssh_key(public_key: str, unique_name: str) -> str:
    """
    Wraps ec2:ImportKeyPair. Call once per SshKey record (lazily, cached onto
    SshKey.aws_key_pair_name) rather than re-importing on every rental.
    Returns the AWS key pair name to use in launch_instance's KeyName param.
    """
    client = _client()
    try:
        client.import_key_pair(KeyName=unique_name, PublicKeyMaterial=public_key.encode("utf-8"))
    except Exception as exc:
        from botocore.exceptions import ClientError

        if isinstance(exc, ClientError) and exc.response.get("Error", {}).get("Code") == "InvalidKeyPair.Duplicate":
            # Already imported under this name (e.g. a retried request) — treat as success.
            return unique_name
        raise _wrap_client_error(exc, "Failed to import SSH key into AWS") from exc
    return unique_name


def delete_ssh_key(aws_key_pair_name: str) -> None:
    """Wraps ec2:DeleteKeyPair. Called when an SshKey is deleted from the account."""
    client = _client()
    try:
        client.delete_key_pair(KeyName=aws_key_pair_name)
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to delete AWS key pair '{aws_key_pair_name}'") from exc


def launch_instance(
    gpu_type: GpuType, storage_gb: int, aws_key_pair_name: str, tags: dict[str, str]
) -> tuple[str, str]:
    """
    Wraps ec2:RunInstances with a gp3 EBS root volume sized to storage_gb,
    the given key pair, and tags identifying which GpuInstance.id this maps
    to (critical for reconciliation/debugging). Returns (aws_instance_id, initial_state).
    """
    if not gpu_type.ami_id:
        raise AwsProviderError(
            f"GpuType '{gpu_type.slug}' has no ami_id configured — refusing to launch "
            "an instance from an unset AMI. Set GpuType.ami_id first."
        )

    client = _client()

    # Resize the AMI's own root volume rather than guessing a device name —
    # this is correct regardless of the AMI's actual root device (/dev/sda1,
    # /dev/xvda, etc.), and never silently launches with the wrong device.
    try:
        images = client.describe_images(ImageIds=[gpu_type.ami_id])["Images"]
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to describe AMI '{gpu_type.ami_id}'") from exc
    if not images:
        raise AwsProviderError(f"AMI '{gpu_type.ami_id}' was not found in region {gpu_type.aws_region}")
    image = images[0]
    root_device_name = image["RootDeviceName"]
    block_device_mappings = [
        {
            "DeviceName": root_device_name,
            "Ebs": {
                "VolumeSize": storage_gb,
                "VolumeType": "gp3",
                "DeleteOnTermination": True,
            },
        }
    ]

    tag_specifications = [
        {
            "ResourceType": "instance",
            "Tags": [{"Key": k, "Value": v} for k, v in tags.items()],
        }
    ]

    try:
        response = client.run_instances(
            ImageId=gpu_type.ami_id,
            InstanceType=gpu_type.aws_instance_type,
            KeyName=aws_key_pair_name,
            MinCount=1,
            MaxCount=1,
            BlockDeviceMappings=block_device_mappings,
            TagSpecifications=tag_specifications,
        )
    except Exception as exc:
        raise _wrap_client_error(exc, "Failed to launch EC2 instance") from exc

    instance = response["Instances"][0]
    return instance["InstanceId"], instance["State"]["Name"]


def stop_instance(aws_instance_id: str) -> None:
    """Wraps ec2:StopInstances."""
    client = _client()
    try:
        client.stop_instances(InstanceIds=[aws_instance_id])
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to stop instance '{aws_instance_id}'") from exc


def start_instance(aws_instance_id: str) -> None:
    """Wraps ec2:StartInstances."""
    client = _client()
    try:
        client.start_instances(InstanceIds=[aws_instance_id])
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to start instance '{aws_instance_id}'") from exc


def terminate_instance(aws_instance_id: str) -> None:
    """Wraps ec2:TerminateInstances."""
    client = _client()
    try:
        client.terminate_instances(InstanceIds=[aws_instance_id])
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to terminate instance '{aws_instance_id}'") from exc


def get_instance_status(aws_instance_id: str) -> InstanceStatus:
    """
    Wraps ec2:DescribeInstances. Public IP is only assigned once running —
    may be None while provisioning or after stopping.
    """
    client = _client()
    try:
        response = client.describe_instances(InstanceIds=[aws_instance_id])
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to describe instance '{aws_instance_id}'") from exc

    reservations = response.get("Reservations", [])
    if not reservations or not reservations[0].get("Instances"):
        raise AwsProviderError(f"Instance '{aws_instance_id}' not found in AWS")
    instance = reservations[0]["Instances"][0]
    return InstanceStatus(
        state=instance["State"]["Name"],
        public_ip=instance.get("PublicIpAddress"),
    )
