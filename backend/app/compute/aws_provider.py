"""
Real AWS EC2 calls for GPU rental provisioning. No simulated fallback exists
anywhere in this module — if AWS credentials are missing/invalid, or any EC2
API call fails, every function here raises a typed exception rather than
pretending an instance is running when it isn't. This mirrors the same
discipline as app/billing/stripe_service.py.

Required IAM policy (least privilege, scoped to the launch regions —
see infra/aws-iam-policy.json for a ready-to-attach JSON document):
  ec2:RunInstances, ec2:StopInstances, ec2:StartInstances,
  ec2:TerminateInstances, ec2:DescribeInstances, ec2:DescribeImages,
  ec2:CreateTags, ec2:ImportKeyPair, ec2:DeleteKeyPair,
  ec2:DescribeVpcs, ec2:DescribeSecurityGroups, ec2:CreateSecurityGroup,
  ec2:AuthorizeSecurityGroupIngress
  ssm:GetParameter (public Deep Learning AMI parameters — regional AMI
  resolution, see app/compute/ami_resolver.py)

Do NOT attach broader permissions than this list.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

from app.config import get_settings
from app.models.compute import GpuType

logger = logging.getLogger("taskflow.aws_provider")

# The security group every workspace GPU launches into. AWS's default security
# group allows NO inbound traffic from the internet, so without this group an
# instance would boot with a public IP that nothing can SSH into — the machine
# would bill the customer while being unreachable. One group per region
# (security groups are regional, like key pairs), created lazily on first
# launch in that region. Free of charge.
SSH_SECURITY_GROUP_NAME = "taskflow-ssh-access"
SSH_SECURITY_GROUP_DESCRIPTION = "TaskFlow workspace SSH access (TCP 22)"
SSH_INGRESS_PORT = 22


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
    availability_zone: Optional[str] = None


class AwsInsufficientCapacityError(AwsRequestError):
    """
    EC2 reported InsufficientInstanceCapacity: it could not fit this instance
    type in the requested region/AZ right now. The scheduler (spec §13) uses
    this to fall back to the next candidate region — it is an expected,
    recoverable provisioning outcome, not a platform bug.
    """


def _client(region_name: Optional[str] = None):
    """
    Lazily constructs a boto3 EC2 client. Imported inside the function (not at
    module load) so environments without boto3/AWS configured can still import
    this module (e.g. for type references) without crashing at import time —
    the actual AWS call is what must fail loudly, not the import.

    region_name selects the launch region (spec §13: the scheduler picks the
    region; the provider must never silently launch into settings.aws_region
    when told to launch elsewhere). None keeps the legacy configured region.
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
        region_name=region_name or settings.aws_region,
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
        if code == "InsufficientInstanceCapacity":
            return AwsInsufficientCapacityError(f"{context}: {message}", aws_error_code=code)
        return AwsRequestError(f"{context}: {message}", aws_error_code=code)
    return AwsRequestError(f"{context}: {exc}")


def import_ssh_key(public_key: str, unique_name: str, region_name: Optional[str] = None) -> str:
    """
    Wraps ec2:ImportKeyPair. Call once per SshKey record (lazily, cached onto
    SshKey.aws_key_pair_name) rather than re-importing on every rental.
    Returns the AWS key pair name to use in launch_instance's KeyName param.

    Key pairs are REGIONAL resources (see services/ssh_keys.py): the caller
    passes the launch region so the key exists where the instance will.
    """
    client = _client(region_name)
    try:
        client.import_key_pair(KeyName=unique_name, PublicKeyMaterial=public_key.encode("utf-8"))
    except Exception as exc:
        from botocore.exceptions import ClientError

        if isinstance(exc, ClientError) and exc.response.get("Error", {}).get("Code") == "InvalidKeyPair.Duplicate":
            # Already imported under this name (e.g. a retried request) — treat as success.
            return unique_name
        raise _wrap_client_error(exc, "Failed to import SSH key into AWS") from exc
    return unique_name


def delete_ssh_key(aws_key_pair_name: str, region_name: Optional[str] = None) -> None:
    """Wraps ec2:DeleteKeyPair. Called when an SshKey is deleted from the account."""
    client = _client(region_name)
    try:
        client.delete_key_pair(KeyName=aws_key_pair_name)
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to delete AWS key pair '{aws_key_pair_name}'") from exc


def ensure_ssh_security_group(region_name: Optional[str] = None) -> str:
    """
    Returns the id of the per-region TaskFlow SSH security group, creating it
    (with TCP 22 open to the internet) on first use.

    Idempotent and safe to call on every launch: an existing group is reused,
    a concurrent create is treated as success, and an already-present ingress
    rule is ignored. Security groups are regional resources, so the lookup and
    creation both happen in the launch region.

    Raises AwsProviderError when the group cannot exist (no default VPC, or
    the IAM policy lacks CreateSecurityGroup/AuthorizeSecurityGroupIngress).
    The caller must NOT launch without it — an unreachable-but-billable
    instance is the failure mode this exists to prevent.
    """
    client = _client(region_name)

    def _find() -> Optional[str]:
        try:
            response = client.describe_security_groups(
                Filters=[{"Name": "group-name", "Values": [SSH_SECURITY_GROUP_NAME]}]
            )
        except Exception as exc:
            raise _wrap_client_error(exc, "Failed to look up the TaskFlow SSH security group") from exc
        for group in response.get("SecurityGroups", []):
            if group.get("GroupName") == SSH_SECURITY_GROUP_NAME:
                return group["GroupId"]
        return None

    existing = _find()
    if existing:
        return existing

    # The group must live in the VPC the instance will launch into — the
    # account's default VPC (RunInstances with no subnet uses it too).
    try:
        vpcs = client.describe_vpcs(Filters=[{"Name": "is-default", "Values": ["true"]}]).get("Vpcs", [])
    except Exception as exc:
        raise _wrap_client_error(exc, "Failed to look up the default VPC") from exc
    if not vpcs:
        raise AwsProviderError(
            f"No default VPC in region '{region_name or get_settings().aws_region}' — "
            "cannot create the SSH security group, refusing to launch an unreachable instance"
        )
    vpc_id = vpcs[0]["VpcId"]

    from botocore.exceptions import ClientError

    try:
        response = client.create_security_group(
            GroupName=SSH_SECURITY_GROUP_NAME,
            Description=SSH_SECURITY_GROUP_DESCRIPTION,
            VpcId=vpc_id,
        )
        group_id = response["GroupId"]
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code not in ("InvalidGroup.Duplicate", "InvalidGroupId.NotFound"):
            raise _wrap_client_error(exc, "Failed to create the SSH security group") from exc
        # Lost a creation race — reuse whichever group now exists.
        existing = _find()
        if not existing:
            raise _wrap_client_error(exc, "Failed to create the SSH security group") from exc
        return existing

    try:
        client.authorize_security_group_ingress(
            GroupId=group_id,
            IpPermissions=[
                {
                    "IpProtocol": "tcp",
                    "FromPort": SSH_INGRESS_PORT,
                    "ToPort": SSH_INGRESS_PORT,
                    "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "SSH"}],
                }
            ],
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code != "InvalidPermission.Duplicate":
            # A group without port 22 open is exactly the unreachable-instance
            # case — clean up rather than launch into a dead group.
            try:
                client.delete_security_group(GroupId=group_id)
            except Exception:  # noqa: BLE001 - best effort, logged below
                logger.warning("Could not roll back partially-created group %s", group_id)
            raise _wrap_client_error(exc, "Failed to open SSH ingress on the security group") from exc

    return group_id


def launch_instance(
    gpu_type: GpuType,
    storage_gb: int,
    aws_key_pair_name: str,
    tags: dict[str, str],
    *,
    region_name: Optional[str] = None,
    ami_id: Optional[str] = None,
    availability_zone: Optional[str] = None,
    user_data: Optional[str] = None,
) -> tuple[str, str, Optional[str]]:
    """
    Wraps ec2:RunInstances with a gp3 EBS root volume sized to storage_gb,
    the given key pair, and tags identifying which GpuInstance.id this maps
    to (critical for reconciliation/debugging).

    region_name + ami_id are the multi-region launch path (spec §13/§15):
    the scheduler resolves the region and the REGIONAL AMI (AMI ids are
    regional and must never be copied between regions), and both are passed
    here explicitly. When omitted, falls back to the legacy single-region
    behaviour: settings.aws_region + gpu_type.ami_id.

    Returns (aws_instance_id, initial_state, availability_zone) — AWS picks
    the AZ inside the region unless one is pinned, and the response reports
    which one it actually used; recording that is what makes AZ balancing
    measurable later (spec §13).
    """
    effective_ami = ami_id or gpu_type.ami_id
    if not effective_ami:
        raise AwsProviderError(
            f"GpuType '{gpu_type.slug}' has no ami_id configured for region "
            f"'{region_name or 'default'}' — refusing to launch an instance from an "
            "unset AMI. Resolve the regional AMI via SSM first."
        )

    client = _client(region_name)
    region_used = region_name or get_settings().aws_region

    # Resize the AMI's own root volume rather than guessing a device name —
    # this is correct regardless of the AMI's actual root device (/dev/sda1,
    # /dev/xvda, etc.), and never silently launches with the wrong device.
    try:
        images = client.describe_images(ImageIds=[effective_ami])["Images"]
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to describe AMI '{effective_ami}'") from exc
    if not images:
        raise AwsProviderError(f"AMI '{effective_ami}' was not found in region {region_used}")
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

    run_params: dict = dict(
        ImageId=effective_ami,
        InstanceType=gpu_type.aws_instance_type,
        KeyName=aws_key_pair_name,
        MinCount=1,
        MaxCount=1,
        BlockDeviceMappings=block_device_mappings,
        TagSpecifications=tag_specifications,
    )
    # SSH must be reachable: resolve/create the shared SSH security group
    # BEFORE RunInstances so a failure here costs nothing. Launching without
    # it would boot a public IP with port 22 closed — a billable machine the
    # customer can never connect to.
    run_params["SecurityGroupIds"] = [ensure_ssh_security_group(region_name)]
    # Taskflow branding (branded prompt + login banner) rides in as user data
    # and is written to disk while the machine boots — see compute/branding.py.
    if user_data:
        run_params["UserData"] = user_data
    if availability_zone:
        run_params["Placement"] = {"AvailabilityZone": availability_zone}

    try:
        response = client.run_instances(**run_params)
    except Exception as exc:
        raise _wrap_client_error(exc, "Failed to launch EC2 instance") from exc

    instance = response["Instances"][0]
    az = (instance.get("Placement") or {}).get("AvailabilityZone")
    return instance["InstanceId"], instance["State"]["Name"], az


def stop_instance(aws_instance_id: str, region_name: Optional[str] = None) -> None:
    """Wraps ec2:StopInstances. region_name must match where the instance lives."""
    client = _client(region_name)
    try:
        client.stop_instances(InstanceIds=[aws_instance_id])
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to stop instance '{aws_instance_id}'") from exc


def start_instance(aws_instance_id: str, region_name: Optional[str] = None) -> None:
    """Wraps ec2:StartInstances. region_name must match where the instance lives."""
    client = _client(region_name)
    try:
        client.start_instances(InstanceIds=[aws_instance_id])
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to start instance '{aws_instance_id}'") from exc


def terminate_instance(aws_instance_id: str, region_name: Optional[str] = None) -> None:
    """Wraps ec2:TerminateInstances. region_name must match where the instance lives."""
    client = _client(region_name)
    try:
        client.terminate_instances(InstanceIds=[aws_instance_id])
    except Exception as exc:
        raise _wrap_client_error(exc, f"Failed to terminate instance '{aws_instance_id}'") from exc


def get_instance_status(aws_instance_id: str, region_name: Optional[str] = None) -> InstanceStatus:
    """
    Wraps ec2:DescribeInstances. Public IP is only assigned once running —
    may be None while provisioning or after stopping.
    """
    client = _client(region_name)
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
        availability_zone=(instance.get("Placement") or {}).get("AvailabilityZone"),
    )
