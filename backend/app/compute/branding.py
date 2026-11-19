"""
Taskflow branding injected into every workspace machine at boot (spec: every
workspace carries the Taskflow identity).

Branding is delivered as EC2 user data — a small bash script written to disk
while the instance boots, before anyone can SSH in:

- /etc/profile.d/taskflow.sh         env vars + the branded PS1 prompt
- /etc/profile.d/taskflow-banner.sh  the login banner (once per session)
- source hook appended to the system/user bashrc files so non-login shells
  get the prompt too

The result on any shell:

    Taskflow$: my-workspace ~$

User data runs on first boot only, and the files live on the root volume, so
the branding survives stop/start cycles (stop does not wipe the disk).

Everything user-supplied is sanitised before it reaches a shell script — a
workspace name can never inject commands into user data.
"""
from __future__ import annotations

import re

# Anything outside a conservative filename/prompt-safe set is stripped.
_UNSAFE = re.compile(r"[^A-Za-z0-9._ -]+")
# Unique heredoc delimiters — no line of the generated files can collide.
_DELIMITER = "TF_TASKFLOW_EOF"


def sanitize_label(value: str | None, fallback: str, max_len: int = 48) -> str:
    """Make a customer-supplied label safe to embed in a shell script."""
    cleaned = _UNSAFE.sub("", (value or "").strip())[:max_len].strip(" .-")
    return cleaned or fallback


def _profile_script(*, workspace_name: str, region: str, gpu_label: str) -> str:
    """Content of /etc/profile.d/taskflow.sh — env + branded prompt."""
    return f"""# Taskflow workspace branding — written at launch by the Taskflow platform.
export TASKFLOW_WORKSPACE='{workspace_name}'
export TASKFLOW_REGION='{region}'
export TASKFLOW_GPU='{gpu_label}'
# Prompt:  Taskflow$: <workspace> <cwd> $
# Note: the prefix uses a LITERAL '$' (root shells would render a backslash-
# escaped dollar as '#'), while the trailing dollar stays escaped so it
# degrades to '#' for root and '$' for everyone else.
PS1='\\[\\e[1;36m\\]Taskflow$:\\[\\e[0m\\] \\[\\e[1;35m\\]${{TASKFLOW_WORKSPACE}}\\[\\e[0m\\] \\[\\e[1;32m\\]\\w\\[\\e[0m\\] \\[\\e[1;33m\\]\\$ \\[\\e[0m\\] '
"""


def _banner_script(*, workspace_name: str, region: str, gpu_label: str, image_name: str) -> str:
    """Content of /etc/profile.d/taskflow-banner.sh — printed once per login."""
    return f"""# Taskflow login banner — printed once per session.
if [ -z "${{TF_BANNER_SHOWN:-}}" ]; then
    export TF_BANNER_SHOWN=1
    printf '\\n'
    printf '  \\033[1;36mTaskflow\\033[0m  \\033[2m·\\033[0m  \\033[1m%s\\033[0m\\n' '{workspace_name}'
    printf '  \\033[2mGPU: %s  |  Region: %s  |  Image: %s\\033[0m\\n' '{gpu_label}' '{region}' '{image_name}'
    printf '  \\033[2mYour GPU runs (and bills hourly) until you stop it from the Taskflow dashboard.\\033[0m\\n'
    printf '\\n'
fi
"""


def build_user_data(
    *,
    workspace_name: str | None,
    region: str,
    gpu_label: str,
    image_name: str,
) -> str:
    """
    The EC2 user-data script for one workspace machine. Returns a bash script
    (must stay well under EC2's 16KB user-data limit — this is ~2KB).
    """
    name = sanitize_label(workspace_name, fallback="workspace")
    region_safe = sanitize_label(region, fallback="unknown-region")
    gpu_safe = sanitize_label(gpu_label, fallback="GPU")
    image_safe = sanitize_label(image_name, fallback="Deep-Learning-AMI")

    profile = _profile_script(workspace_name=name, region=region_safe, gpu_label=gpu_safe)
    banner = _banner_script(
        workspace_name=name, region=region_safe, gpu_label=gpu_safe, image_name=image_safe
    )

    return f"""#!/bin/bash
# Taskflow workspace branding — injected as user data at launch.
mkdir -p /etc/profile.d
cat > /etc/profile.d/taskflow.sh <<'{_DELIMITER}'
{profile}{_DELIMITER}
cat > /etc/profile.d/taskflow-banner.sh <<'{_DELIMITER}'
{banner}{_DELIMITER}
chmod 0644 /etc/profile.d/taskflow.sh /etc/profile.d/taskflow-banner.sh

# Non-login interactive shells (bash) must pick the prompt up too.
for tf_rc in /etc/bashrc /etc/bash.bashrc /root/.bashrc /home/*/.bashrc; do
    [ -f "$tf_rc" ] || continue
    grep -q 'profile.d/taskflow.sh' "$tf_rc" 2>/dev/null && continue
    printf '\\n# Taskflow branding\\n[ -f /etc/profile.d/taskflow.sh ] && . /etc/profile.d/taskflow.sh\\n' >> "$tf_rc"
done
exit 0
"""
