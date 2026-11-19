"""
Workspace = the machine (rent flow): a workspace picks its GPU + image and
boots on AWS in the same request; branding rides in as user data; SSH is
reachable because the security group is resolved BEFORE RunInstances.

Covers, with zero real AWS/network access:
- AMI resolution: SSM first, ec2:DescribeImages fallback, newest available
  build wins, both-fail raises (never a guessed id)
- custom workspace images resolve live and never pollute the row cache
- Taskflow branding user data: prompt, banner, env, sanitised labels
- ensure_ssh_security_group: reuse / create / open TCP 22 / fail closed
- image catalogue endpoint (free/paid flags, default image)
- POST /workspaces with a GPU: boots + bills in one request, all-or-nothing
- POST /workspaces/{id}/gpu on an existing workspace
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import select

from app.compute import ami_resolver, aws_provider, branding
from app.database import get_db
from app.models.billing import CreditTransactionType, Plan, PlanCode, Subscription, SubscriptionStatus
from app.models.compute import GpuInstance, MachineImage
from app.models.region import GpuRegionAvailability, GpuRegionStatus, Region, RegionStatus
from app.models.workspace import StorageSize
from app.services import credits as credits_service


# ---------------------------------------------------------------- helpers


def _client_for(db_session):
    import app.main as main_module

    main_module.app.dependency_overrides[get_db] = lambda: db_session
    return TestClient(main_module.app)


def _auth_header(organization_id: uuid.UUID, role: str = "OWNER") -> dict:
    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(organization_id), "role": role},
        "test-secret-test-secret-test-secret-32",
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _top_up(db, organization_id, amount_micros):
    credits_service.record_transaction(
        db, organization_id=organization_id, type=CreditTransactionType.PURCHASE,
        amount_micros=amount_micros, description="test top-up",
    )


def _add_size(db, size_gb=50, hourly=0, prepaid=0, plans=("FREE", "PRO", "ULTRA", "MAX"), enabled=True):
    row = StorageSize(
        size_gb=size_gb, display_name=f"{size_gb} GB", hourly_price_micros=hourly,
        prepaid_price_micros=prepaid, available_plans=list(plans), enabled=enabled,
    )
    db.add(row)
    db.commit()
    return row


def _image(db, **overrides):
    defaults = dict(
        slug=f"img-{uuid.uuid4().hex[:8]}",
        display_name="PyTorch 2.13 · Amazon Linux 2023",
        description="test image",
        name_pattern="Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.13 (Amazon Linux 2023)*",
        hourly_price_micros=0,
        enabled=True,
        is_default=False,
        sort_order=0,
    )
    defaults.update(overrides)
    row = MachineImage(**defaults)
    db.add(row)
    db.flush()
    return row


def _pro_org(db, organization):
    plan = db.execute(select(Plan).where(Plan.code == PlanCode.PRO)).scalar_one()
    plan.included_workspaces = 5
    plan.workspace_storage_gb = 500
    db.add(Subscription(organization_id=organization.id, plan_id=plan.id, status=SubscriptionStatus.ACTIVE))
    db.commit()
    return organization


# ---------------------------------------------------------------- AMI resolver


class _FakeSsm:
    def __init__(self, value=None, error=None):
        self._value = value
        self._error = error
        self.calls = []

    def get_parameter(self, Name):
        self.calls.append(Name)
        if self._error is not None:
            raise self._error
        return {"Parameter": {"Value": self._value}}


class _FakeEc2:
    def __init__(self, images=None, error=None):
        self._images = images or []
        self._error = error
        self.calls = []

    def describe_images(self, Owners, Filters):
        self.calls.append({"Owners": Owners, "Filters": Filters})
        if self._error is not None:
            raise self._error
        return {"Images": self._images}


def test_ami_ssm_path_used_when_parameter_resolves(monkeypatch):
    ssm = _FakeSsm(value="ami-ssm-default")
    monkeypatch.setattr(ami_resolver, "_ssm_client", lambda region: ssm)

    ami = ami_resolver.resolve_ami("eu-west-2")
    assert ami == "ami-ssm-default"
    assert len(ssm.calls) == 1


def test_ami_falls_back_to_describe_images_when_ssm_denied(monkeypatch):
    # SSM denied (the pre-policy world) must still resolve a REAL id.
    monkeypatch.setattr(
        ami_resolver, "_ssm_client",
        lambda region: _FakeSsm(error=RuntimeError("AccessDeniedException")),
    )
    ec2 = _FakeEc2(images=[
        {"ImageId": "ami-old", "State": "available", "CreationDate": "2026-01-01T00:00:00.000Z"},
        {"ImageId": "ami-newest", "State": "available", "CreationDate": "2026-11-14T00:00:00.000Z"},
        # Non-available builds are filtered client-side and must never win.
        {"ImageId": "ami-pending", "State": "pending", "CreationDate": "2026-11-18T00:00:00.000Z"},
        {"ImageId": "ami-dereg", "State": "deregistered", "CreationDate": "2026-11-17T00:00:00.000Z"},
    ])
    monkeypatch.setattr(ami_resolver, "_ec2_client", lambda region: ec2)

    ami = ami_resolver.resolve_ami("eu-west-2")
    assert ami == "ami-newest"  # newest AVAILABLE build, not the newest row
    # The query is scoped to Amazon-owned images matching the name pattern.
    assert ec2.calls[0]["Owners"] == ["amazon"]
    assert ec2.calls[0]["Filters"][0]["Name"] == "name"
    assert "PyTorch 2.13" in ec2.calls[0]["Filters"][0]["Values"][0]


def test_ami_both_paths_fail_raises_never_guesses(monkeypatch):
    monkeypatch.setattr(
        ami_resolver, "_ssm_client",
        lambda region: _FakeSsm(error=RuntimeError("denied")),
    )
    monkeypatch.setattr(
        ami_resolver, "_ec2_client",
        lambda region: _FakeEc2(error=RuntimeError("AuthFailure")),
    )
    with pytest.raises(ami_resolver.AmiResolutionError):
        ami_resolver.resolve_ami("eu-west-2")


def test_ami_describe_images_no_match_raises(monkeypatch):
    monkeypatch.setattr(
        ami_resolver, "_ssm_client",
        lambda region: _FakeSsm(error=RuntimeError("denied")),
    )
    monkeypatch.setattr(ami_resolver, "_ec2_client", lambda region: _FakeEc2(images=[]))
    with pytest.raises(ami_resolver.AmiResolutionError):
        ami_resolver.resolve_ami("eu-west-2")


def test_custom_image_resolves_live_and_never_pollutes_row_cache(db_session, organization, gpu_type):
    """A workspace's image must never write its AMI id onto the shared row."""
    region = Region(
        aws_region_code="eu-west-2", public_name="UK London", country_or_area="UK",
        status=RegionStatus.AVAILABLE,
    )
    db_session.add(region)
    db_session.flush()
    row = GpuRegionAvailability(
        gpu_type_id=gpu_type.id, region_id=region.id, status=GpuRegionStatus.AVAILABLE,
        premium_micros=0, aws_cost_est_micros_per_hour=0, ami_id="ami-default-cached",
    )
    db_session.add(row)
    db_session.commit()

    calls = []
    monkey_target = ami_resolver
    original = monkey_target.resolve_ami_from_describe_images

    def counting(region_name, name_pattern=None):
        calls.append((region_name, name_pattern))
        return "ami-custom-live"

    monkey_target.resolve_ami_from_describe_images = counting
    try:
        ami = ami_resolver.get_or_resolve_ami(
            db_session, row, name_pattern="Some Other Image*"
        )
    finally:
        monkey_target.resolve_ami_from_describe_images = original

    assert ami == "ami-custom-live"
    assert calls == [("eu-west-2", "Some Other Image*")]
    # Row cache untouched — the default image's id must never be swapped out.
    assert row.ami_id == "ami-default-cached"


# ---------------------------------------------------------------- branding


def test_user_data_carries_taskflow_prompt_and_banner():
    user_data = branding.build_user_data(
        workspace_name="my-train-box",
        region="eu-west-2",
        gpu_label="NVIDIA A10G",
        image_name="PyTorch 2.13 Amazon Linux 2023",
    )
    assert user_data.startswith("#!/bin/bash")
    # The branded prompt the user asked for: Taskflow$: <name>
    assert "Taskflow$:" in user_data
    assert "TASKFLOW_WORKSPACE='my-train-box'" in user_data
    assert "TASKFLOW_REGION='eu-west-2'" in user_data
    assert "TASKFLOW_GPU='NVIDIA A10G'" in user_data
    # Login banner with GPU/region/image and the billing reminder.
    assert "taskflow-banner.sh" in user_data
    assert "bills hourly" in user_data
    # Branding survives stop/start: files live on the root volume.
    assert "/etc/profile.d/taskflow.sh" in user_data
    # Must stay far under EC2's 16KB user-data limit.
    assert len(user_data.encode()) < 16_000


def test_user_data_labels_are_sanitised():
    user_data = branding.build_user_data(
        workspace_name="evil'; rm -rf / #",
        region="eu-west-2",
        gpu_label="NVIDIA $(reboot)",
        image_name="img`whoami`",
    )
    # Customer-supplied labels are stripped to a safe character set before
    # they reach the script — no command substitution, quotes or separators.
    assert "$(reboot)" not in user_data
    assert "`whoami`" not in user_data
    assert "evil';" not in user_data
    # What remains is inert text inside single quotes (sanitised, not raw).
    assert "TASKFLOW_WORKSPACE='evil rm -rf'" in user_data
    assert "TASKFLOW_GPU='NVIDIA reboot'" in user_data


def test_sanitize_label_strips_and_falls_back():
    assert branding.sanitize_label("my workspace-01", fallback="x") == "my workspace-01"
    assert branding.sanitize_label("$(evil)", fallback="x") == "evil"
    assert branding.sanitize_label("   ", fallback="workspace") == "workspace"
    assert branding.sanitize_label(None, fallback="workspace") == "workspace"
    # Length-capped so user data can never bloat past the EC2 limit.
    assert len(branding.sanitize_label("a" * 500, fallback="x")) <= 48


# ---------------------------------------------------------------- SSH security group


class _FakeSgEc2:
    """Minimal EC2 client stand-in for ensure_ssh_security_group."""

    def __init__(self, groups=None, vpcs=("vpc-default",), fail_auth=False):
        self.groups = groups or []
        self.vpcs = list(vpcs)
        self.fail_auth = fail_auth
        self.created = []
        self.ingress = []
        self.deleted = []

    def describe_security_groups(self, Filters):
        name = Filters[0]["Values"][0]
        return {"SecurityGroups": [g for g in self.groups if g["GroupName"] == name]}

    def describe_vpcs(self, Filters):
        return {"Vpcs": [{"VpcId": v} for v in self.vpcs]}

    def create_security_group(self, GroupName, Description, VpcId):
        from botocore.exceptions import ClientError

        if any(g["GroupName"] == GroupName for g in self.groups):
            raise ClientError(
                {"Error": {"Code": "InvalidGroup.Duplicate", "Message": "exists"}},
                "CreateSecurityGroup",
            )
        group_id = f"sg-{len(self.created) + 1}"
        self.created.append({"GroupName": GroupName, "VpcId": VpcId, "GroupId": group_id})
        self.groups.append({"GroupName": GroupName, "GroupId": group_id})
        return {"GroupId": group_id}

    def authorize_security_group_ingress(self, GroupId, IpPermissions):
        from botocore.exceptions import ClientError

        if self.fail_auth:
            raise ClientError(
                {"Error": {"Code": "UnauthorizedOperation", "Message": "no permission"}},
                "AuthorizeSecurityGroupIngress",
            )
        self.ingress.append({"GroupId": GroupId, "IpPermissions": IpPermissions})

    def delete_security_group(self, GroupId):
        self.deleted.append(GroupId)


def test_ssh_security_group_reuses_existing(monkeypatch):
    client = _FakeSgEc2(groups=[{"GroupName": "taskflow-ssh-access", "GroupId": "sg-existing"}])
    monkeypatch.setattr(aws_provider, "_client", lambda region_name=None: client)

    sg_id = aws_provider.ensure_ssh_security_group("eu-west-2")
    assert sg_id == "sg-existing"
    assert client.created == []  # no duplicate create


def test_ssh_security_group_created_and_opens_port_22(monkeypatch):
    client = _FakeSgEc2()
    monkeypatch.setattr(aws_provider, "_client", lambda region_name=None: client)

    sg_id = aws_provider.ensure_ssh_security_group("eu-west-2")
    assert sg_id == "sg-1"
    assert client.created[0]["GroupName"] == "taskflow-ssh-access"
    assert client.created[0]["VpcId"] == "vpc-default"
    # Port 22 open to the internet — without this an instance would bill
    # the customer while being unreachable over SSH.
    assert len(client.ingress) == 1
    rule = client.ingress[0]["IpPermissions"][0]
    assert rule["IpProtocol"] == "tcp"
    assert rule["FromPort"] == 22 and rule["ToPort"] == 22
    assert rule["IpRanges"][0]["CidrIp"] == "0.0.0.0/0"


def test_ssh_security_group_fails_closed_without_default_vpc(monkeypatch):
    client = _FakeSgEc2(vpcs=[])
    monkeypatch.setattr(aws_provider, "_client", lambda region_name=None: client)

    with pytest.raises(aws_provider.AwsProviderError):
        aws_provider.ensure_ssh_security_group("eu-west-2")
    # Never returns a group id when none exists — the caller must not launch.
    assert client.created == []


def test_ssh_security_group_ingress_failure_rolls_back_group(monkeypatch):
    client = _FakeSgEc2(fail_auth=True)
    monkeypatch.setattr(aws_provider, "_client", lambda region_name=None: client)

    with pytest.raises(aws_provider.AwsRequestError):
        aws_provider.ensure_ssh_security_group("eu-west-2")
    # A group without port 22 open is the unreachable-instance case: cleaned
    # up rather than launched into.
    assert client.deleted == ["sg-1"]


# ---------------------------------------------------------------- image catalogue


def test_image_catalogue_endpoint_lists_free_images(db_session, organization):
    _image(db_session, slug="pytorch-default", is_default=True, sort_order=10)
    _image(
        db_session, slug="base-cuda", display_name="Base CUDA · Amazon Linux 2023",
        sort_order=20,
    )
    # Disabled images are hidden from the catalogue.
    _image(db_session, slug="retired", enabled=False, sort_order=30)
    db_session.commit()

    client = _client_for(db_session)
    res = client.get("/compute/images", headers=_auth_header(organization.id))
    assert res.status_code == 200
    images = res.json()["images"]
    assert [i["slug"] for i in images] == ["pytorch-default", "base-cuda"]
    # Free on AWS -> free with us; the flag drives the Free/Paid badge.
    assert all(i["is_free"] is True for i in images)
    assert all(i["hourly_price_micros"] == 0 for i in images)
    assert images[0]["is_default"] is True
    assert images[1]["is_default"] is False
    # No auth -> no catalogue.
    assert _client_for(db_session).get("/compute/images").status_code == 401


def test_gpu_types_endpoint_returns_plan_allowances(db_session, organization, gpu_type):
    client = _client_for(db_session)
    res = client.get("/compute/gpu-types", headers=_auth_header(organization.id))
    assert res.status_code == 200
    plan = res.json()["plan"]
    assert plan["code"] == "FREE"
    assert plan["max_concurrent_rentals"] == 1
    assert plan["max_storage_gb"] == 50
    # Every SKU in the catalogue is rentable — no "coming soon" placeholders.
    assert all(sku["enabled"] for sku in res.json()["gpu_types"])


# ---------------------------------------------------------------- workspace + GPU


def _launch_stub(calls, fail=False):
    def _launch(gpu_type, storage_gb, key_name, tags, **kwargs):
        calls.append({"tags": tags, **kwargs})
        if fail:
            raise aws_provider.AwsProviderError("boom")
        return "i-test-1", "pending", "eu-west-2a"

    return _launch


def _import_key_stub(monkeypatch):
    monkeypatch.setattr(
        aws_provider, "import_ssh_key",
        lambda public_key, unique_name, region_name=None: unique_name,
    )


def test_create_workspace_with_gpu_boots_and_starts_billing(
    db_session, organization, gpu_type, ssh_key, monkeypatch
):
    _add_size(db_session, 50)
    _top_up(db_session, organization.id, 50_000_000)
    db_session.commit()

    calls = []
    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub(calls))
    _import_key_stub(monkeypatch)

    client = _client_for(db_session)
    headers = _auth_header(organization.id)
    res = client.post(
        "/workspaces",
        json={
            "name": "train-box",
            "storage_size_gb": 50,
            "ssh_key_id": str(ssh_key.id),
            "gpu": {"gpu_type_slug": "standard", "quantity": 1, "payment_mode": "pay_as_you_go"},
        },
        headers=headers,
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["gpu_started"] is True
    assert body["active_gpu_count"] == 1
    assert body["checkout_url"] is None  # PAYG boots immediately, no Stripe hop
    ws_id = body["id"]

    # The machine is real: one launch call, tagged, with branded user data.
    assert len(calls) == 1
    assert calls[0]["tags"]["Name"].startswith("taskflow-")
    assert "Taskflow$:" in calls[0]["user_data"]

    # Billing is live: a RUNNING-track rental exists against the workspace.
    rentals = client.get("/compute/rentals", headers=headers).json()["rentals"]
    assert len(rentals) == 1
    assert rentals[0]["workspace_id"] == ws_id
    assert rentals[0]["hourly_rate_micros"] > 0

    # And the workspace reports its GPU.
    listed = client.get("/workspaces", headers=headers).json()["workspaces"]
    assert listed[0]["active_gpu_count"] == 1


def test_create_workspace_with_gpu_is_all_or_nothing(
    db_session, organization, gpu_type, ssh_key, monkeypatch
):
    _add_size(db_session, 50)
    _top_up(db_session, organization.id, 50_000_000)
    db_session.commit()

    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub([], fail=True))
    _import_key_stub(monkeypatch)

    client = _client_for(db_session)
    headers = _auth_header(organization.id)
    res = client.post(
        "/workspaces",
        json={
            "name": "doomed",
            "storage_size_gb": 50,
            "ssh_key_id": str(ssh_key.id),
            "gpu": {"gpu_type_slug": "standard", "quantity": 1},
        },
        headers=headers,
    )
    # AWS refused -> the customer gets a clear error and NOTHING behind:
    # no workspace, no GPU row, no wallet movement.
    assert res.status_code == 502
    assert client.get("/workspaces", headers=headers).json()["workspaces"] == []
    assert db_session.execute(select(GpuInstance)).scalars().all() == []
    wallet = client.get("/compute/wallet", headers=headers).json()
    assert wallet["balance_micros"] == 50_000_000


def test_create_workspace_without_gpu_still_works(db_session, organization, gpu_type, ssh_key):
    _add_size(db_session, 50)

    client = _client_for(db_session)
    headers = _auth_header(organization.id)
    res = client.post(
        "/workspaces",
        json={"name": "storage-only", "storage_size_gb": 50, "ssh_key_id": str(ssh_key.id)},
        headers=headers,
    )
    assert res.status_code == 200
    body = res.json()
    assert body["gpu_started"] is False
    assert body["active_gpu_count"] == 0
    assert body["image_slug"] is None  # no image picked -> platform default at boot


def test_start_gpu_on_existing_workspace(db_session, organization, gpu_type, ssh_key, monkeypatch):
    _add_size(db_session, 50)
    _top_up(db_session, organization.id, 50_000_000)
    db_session.commit()

    client = _client_for(db_session)
    headers = _auth_header(organization.id)
    res = client.post(
        "/workspaces",
        json={"name": "later", "storage_size_gb": 50, "ssh_key_id": str(ssh_key.id)},
        headers=headers,
    )
    assert res.status_code == 200
    ws_id = res.json()["id"]
    assert res.json()["active_gpu_count"] == 0

    calls = []
    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub(calls))
    _import_key_stub(monkeypatch)

    res = client.post(
        f"/workspaces/{ws_id}/gpu",
        json={"gpu_type_slug": "standard", "quantity": 1, "payment_mode": "pay_as_you_go"},
        headers=headers,
    )
    assert res.status_code == 200, res.text
    assert res.json()["gpu_started"] is True
    assert res.json()["active_gpu_count"] == 1
    assert len(calls) == 1

    # Adding a second GPU on FREE (limit 1) is refused — plan limits are
    # enforced server-side, not just greyed out in the UI.
    res = client.post(
        f"/workspaces/{ws_id}/gpu",
        json={"gpu_type_slug": "standard", "quantity": 1},
        headers=headers,
    )
    assert res.status_code == 409


def test_start_gpu_failure_keeps_workspace_intact(
    db_session, organization, gpu_type, ssh_key, monkeypatch
):
    _add_size(db_session, 50)
    _top_up(db_session, organization.id, 50_000_000)
    db_session.commit()

    client = _client_for(db_session)
    headers = _auth_header(organization.id)
    res = client.post(
        "/workspaces",
        json={"name": "keep-me", "storage_size_gb": 50, "ssh_key_id": str(ssh_key.id)},
        headers=headers,
    )
    ws_id = res.json()["id"]

    monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub([], fail=True))
    _import_key_stub(monkeypatch)

    res = client.post(
        f"/workspaces/{ws_id}/gpu",
        json={"gpu_type_slug": "standard", "quantity": 1},
        headers=headers,
    )
    assert res.status_code == 502
    # Unlike workspace creation, a failed START only rolls back the GPU
    # attempt — the workspace and its storage survive for a retry.
    listed = client.get("/workspaces", headers=headers).json()["workspaces"]
    assert [w["id"] for w in listed] == [ws_id]
    assert listed[0]["active_gpu_count"] == 0


def test_start_gpu_without_ssh_key_fails_before_launch(
    db_session, organization, gpu_type, monkeypatch
):
    _add_size(db_session, 50)
    _top_up(db_session, organization.id, 50_000_000)
    db_session.commit()

    client = _client_for(db_session)
    headers = _auth_header(organization.id)
    res = client.post(
        "/workspaces", json={"name": "no-key", "storage_size_gb": 50}, headers=headers
    )
    ws_id = res.json()["id"]

    launched = []
    monkeypatch.setattr(
        aws_provider, "launch_instance",
        lambda *a, **k: launched.append(k) or ("i-x", "pending", "eu-west-2a"),
    )
    _import_key_stub(monkeypatch)

    res = client.post(
        f"/workspaces/{ws_id}/gpu", json={"gpu_type_slug": "standard"}, headers=headers
    )
    # No SSH key -> no launch: a machine nobody can reach must never bill.
    assert res.status_code == 400
    assert "SSH key" in res.json()["detail"]
    assert launched == []


def test_workspace_creation_with_unknown_image_rejected(db_session, organization, ssh_key):
    _add_size(db_session, 50)
    client = _client_for(db_session)
    headers = _auth_header(organization.id)
    res = client.post(
        "/workspaces",
        json={"name": "bad-image", "storage_size_gb": 50, "ssh_key_id": str(ssh_key.id),
              "image_slug": "does-not-exist"},
        headers=headers,
    )
    assert res.status_code == 400
    assert "image" in res.json()["detail"].lower()
    assert client.get("/workspaces", headers=headers).json()["workspaces"] == []


def test_workspace_stores_chosen_image(db_session, organization, ssh_key):
    _add_size(db_session, 50)
    image = _image(db_session, slug="pytorch-2-13-al2023", is_default=True)
    db_session.commit()

    client = _client_for(db_session)
    headers = _auth_header(organization.id)
    res = client.post(
        "/workspaces",
        json={"name": "with-image", "storage_size_gb": 50, "ssh_key_id": str(ssh_key.id),
              "image_slug": image.slug},
        headers=headers,
    )
    assert res.status_code == 200
    body = res.json()
    assert body["image_slug"] == "pytorch-2-13-al2023"
    assert body["image_display_name"] == "PyTorch 2.13 · Amazon Linux 2023"
    assert body["image_id"] is not None


def test_region_matrix_workspace_launch_uses_image_pattern(
    db_session, organization, gpu_type, ssh_key, monkeypatch
):
    """With a regional matrix, the chosen image's pattern reaches the resolver."""
    _add_size(db_session, 50)
    _top_up(db_session, organization.id, 50_000_000)
    image = _image(
        db_session, slug="custom-img", name_pattern="Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023)*"
    )
    db_session.commit()

    region = Region(
        aws_region_code="eu-west-2", public_name="UK London", country_or_area="UK",
        status=RegionStatus.AVAILABLE,
    )
    db_session.add(region)
    db_session.flush()
    db_session.add(GpuRegionAvailability(
        gpu_type_id=gpu_type.id, region_id=region.id, status=GpuRegionStatus.AVAILABLE,
        premium_micros=0, aws_cost_est_micros_per_hour=0,
    ))
    db_session.commit()

    resolved = []
    original = ami_resolver.resolve_ami_from_describe_images

    def counting(region_name, name_pattern=None):
        resolved.append(name_pattern)
        return "ami-custom-region"

    ami_resolver.resolve_ami_from_describe_images = counting
    try:
        calls = []
        monkeypatch.setattr(aws_provider, "launch_instance", _launch_stub(calls))
        _import_key_stub(monkeypatch)

        client = _client_for(db_session)
        res = client.post(
            "/workspaces",
            json={"name": "img-launch", "storage_size_gb": 50, "ssh_key_id": str(ssh_key.id),
                  "image_slug": image.slug,
                  "gpu": {"gpu_type_slug": "standard", "quantity": 1}},
            headers=_auth_header(organization.id),
        )
    finally:
        ami_resolver.resolve_ami_from_describe_images = original

    assert res.status_code == 200, res.text
    # The workspace's image pattern (not the default one) resolved the AMI.
    assert resolved and all(
        p == "Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023)*" for p in resolved
    )
    assert calls[0]["ami_id"] == "ami-custom-region"
    assert calls[0]["user_data"].startswith("#!/bin/bash")
