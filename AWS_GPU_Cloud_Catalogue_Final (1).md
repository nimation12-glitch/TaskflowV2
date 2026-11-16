# AWS GPU Cloud Catalogue & Platform Architecture

## Planning specification — GPU rental only

**Infrastructure:** Amazon Web Services (AWS)

**Product:** GPU rental / dedicated GPU cloud

**Launch subscription plans:** Free / Pro / Ultra / Max

**GPU tiers:** Starter / Standard / Pro / Ultra

**Supported launch regions:** US East (N. Virginia), US West (Oregon), EU North (Stockholm), UK London, EU Central (Frankfurt), Asia Pacific (Tokyo)

**Primary GPU AMI:** Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.13 (Amazon Linux 2023), x86_64, resolved regionally through AWS Systems Manager Parameter Store.

> **Important:** This is a GPU-only platform specification. AI model hosting, inference routing, OpenAI/Anthropic integration and other AI-model services are intentionally out of scope for the initial product.

> **Pricing model:** Customer-facing GPU prices are fixed base prices. A separate fixed regional service premium is added when applicable. The production control plane should still monitor live AWS costs internally and refuse or reroute capacity when infrastructure cost exceeds the platform's safe operating threshold. Customer prices should not automatically change every time AWS changes its price.

---

# 1. Product model

The platform is a managed GPU cloud built on top of AWS.

Customers choose a GPU configuration and a persistent workspace. They do **not** need to choose an AWS region, Availability Zone, AMI, subnet or instance type.

The platform automatically selects suitable infrastructure based on:

- GPU availability
- supported region
- supported AMI
- persistent-storage compatibility
- SSH provisioning compatibility
- estimated startup time
- current infrastructure cost
- capacity and workload requirements
- optional customer location preference

The customer experiences one cloud even though the platform may provision the GPU in different AWS regions.

```text
Customer
   |
   v
GPU catalogue
   |
   v
Workspace selection
   |
   v
GPU scheduler
   |
   +---- capacity check
   +---- region check
   +---- AMI compatibility
   +---- startup-time estimate
   +---- storage compatibility
   +---- infrastructure-cost check
   |
   v
Best supported region / AZ
   |
   v
EC2 GPU instance
   |
   +---- persistent workspace
   +---- SSH identity
   +---- security configuration
   |
   v
Health checks
   |
   v
READY
```

---

# 2. Subscription plans

Subscriptions provide **access, workspace allowances and account limits**. They do not include unlimited GPU compute.

Actual GPU rental is separately metered through the customer's real-money wallet.

| Plan | Monthly price | GPU access | Included workspaces |
|---|---:|---|---|
| **Free** | **£0/month** | Starter | **1 free 50 GB workspace** |
| **Pro** | **£35/month** | Starter + Standard | **5 free 500 GB workspaces** |
| **Ultra** | **£65/month** | Starter + Standard + Pro | **10 free 500 GB workspaces** |
| **Max** | **£100/month** | **All GPU tiers** | **15 free 1 TB workspaces** |

## Plan access matrix

| Feature | Free | Pro | Ultra | Max |
|---|:---:|:---:|:---:|:---:|
| Starter GPUs | ✅ | ✅ | ✅ | ✅ |
| Standard GPUs | ❌ | ✅ | ✅ | ✅ |
| Pro GPUs | ❌ | ❌ | ✅ | ✅ |
| Ultra GPUs | ❌ | ❌ | ❌ | ✅ |
| Included workspaces | 2 | 5 | 10 | 15 |
| Included storage per workspace | 50 GB | 500 GB | 500 GB | 1 TB |
| Dedicated GPU access | Limited | ✅ | ✅ | ✅ |
| Multi-GPU configurations | Limited | ✅ | ✅ | ✅ |

The plan limits apply at the customer-account level. Deleting a workspace frees a workspace slot.

---

# 3. Wallet and billing model

The subscription is **access, not unlimited compute**.

Each customer has a real-money wallet. GPU rental time, paid storage upgrades and other metered GPU-cloud products deduct from that balance.

```text
Subscription fee
      +
Real-money wallet top-up
      |
      v
GPU rental / paid storage usage
      |
      v
Wallet decreases automatically
      |
      +---- low balance -> warning
      |
      +---- insufficient balance -> reject new paid work
```

Before starting a GPU, the platform should require enough wallet balance for the minimum billable rental / reserve.

During active rental:

```text
Wallet balance
      |
      v
Continuous usage metering
      |
      +---- low balance -> warning
      |
      +---- exhausted -> stop / pause new paid work
```

The billing service must remain the source of truth for what the customer owes. The frontend must never decide the authoritative cost.

---

# 4. Workspace model

A **workspace** is the customer's persistent environment around a GPU rental.

Each workspace can contain:

```text
Workspace
├── Persistent storage
├── Persistent SSH identity
├── Customer files
├── Environment configuration
└── GPU attachment
```

The GPU is temporary compute. The workspace persists until the customer explicitly deletes it.

## Workspace lifecycle

```text
Workspace CREATED
        |
        v
Persistent storage created
        |
        v
SSH identity attached
        |
        v
GPU rented
        |
        v
GPU provisioned
        |
        v
Workspace attached
        |
        v
Customer works
        |
        v
GPU released
        |
        v
Workspace remains
```

A customer can later rent another compatible GPU and reconnect the same workspace.

---

# 5. Persistent SSH identity

SSH access is persistent at the workspace/account level rather than being tied permanently to one EC2 instance.

The customer should not need to generate a completely new SSH setup every time a GPU is rented.

```text
Customer SSH identity
        |
        +---- encrypted/private material stored securely
        |
        +---- public key provisioned to GPU

Workspace
        |
        +---- public SSH key
        +---- connection metadata
```

The private key must **not** be stored unnecessarily on the GPU instance. The instance receives the public key needed for SSH authentication.

When a GPU is replaced:

```text
Old GPU terminated
       |
       v
Workspace remains
       |
       v
New GPU launched
       |
       v
Public SSH key provisioned
       |
       v
Same workspace / same SSH identity
```

A workspace deletion is separate from GPU release.

---

# 6. Workspace limits by plan

| Plan | Free workspace allocation | Maximum included storage |
|---|---:|---:|
| **Free** | **1 × 50 GB workspace** | **50 GB total** |
| **Pro** | **5 × 500 GB workspaces** | **2.5 TB total** |
| **Ultra** | **10 × 500 GB workspaces** | **5 TB total** |
| **Max** | **15 × 1 TB workspaces** | **15 TB total** |

These are **included workspace entitlements**. Actual storage infrastructure is provisioned when a workspace is created/activated, so the platform does not have to provision every possible allowance for every customer in advance.

---

# 7. Storage catalogue

Storage is attached to a workspace and persists independently from the GPU lifecycle. GPU compute is metered separately from persistent storage.

A workspace can remain alive with its GPU stopped or released. While the workspace exists, storage billing continues. Deleting the workspace ends future storage billing and removes the persistent environment according to the deletion policy.

## Storage pricing

| Storage option | Free | Pro | Ultra | Max | Hourly price when paid | 30-day prepaid price when paid |
|---|:---:|:---:|:---:|:---:|---:|---:|
| **50 GB** | ✅ Included | ❌ | ❌ | ❌ | **£0.01/hr** | **£5.99 / 30 days** |
| **100 GB** | ✅ Paid | ❌ | ❌ | ❌ | **£0.02/hr** | **£9.99 / 30 days** |
| **250 GB** | ✅ Paid | ❌ | ❌ | ❌ | **£0.04/hr** | **£19.99 / 30 days** |
| **500 GB** | ❌ | ✅ Included | ✅ Included | ❌ | **£0.07/hr** | **£34.99 / 30 days** |
| **1 TB** | ❌ | ✅ Paid | ✅ Paid | ✅ Included | **£0.14/hr** | **£69.99 / 30 days** |
| **2 TB** | ❌ | ✅ Paid | ✅ Paid | ✅ Paid | **£0.27/hr** | **£134.99 / 30 days** |
| **5 TB** | ❌ | ✅ Paid | ✅ Paid | ✅ Paid | **£0.65/hr** | **£324.99 / 30 days** |
| **10 TB** | ❌ | ❌ | ❌ | ✅ Paid | **£1.25/hr** | **£624.99 / 30 days** |

There is no custom storage product at launch.

### Free

```text
1 free 50 GB workspace
```

Paid upgrades per workspace:

- 100 GB — **£0.02/hr** or **£9.99 / 30 days**
- 250 GB — **£0.04/hr** or **£19.99 / 30 days**

Free cannot create unlimited free workspaces. The workspace slot is a hard account-level limit.

### Pro

```text
5 free 500 GB workspaces
```

Paid upgrades:

- 1 TB — **£0.14/hr** or **£69.99 / 30 days**
- 2 TB — **£0.27/hr** or **£134.99 / 30 days**
- 5 TB — **£0.65/hr** or **£324.99 / 30 days**

50 GB, 100 GB and 250 GB are not offered as Pro workspace sizes.

### Ultra

```text
10 free 500 GB workspaces
```

Paid upgrades:

- 1 TB — **£0.14/hr** or **£69.99 / 30 days**
- 2 TB — **£0.27/hr** or **£134.99 / 30 days**
- 5 TB — **£0.65/hr** or **£324.99 / 30 days**

50 GB, 100 GB and 250 GB are not offered as Ultra workspace sizes.

### Max

```text
15 free 1 TB workspaces
```

Paid upgrades:

- 2 TB — **£0.27/hr** or **£134.99 / 30 days**
- 5 TB — **£0.65/hr** or **£324.99 / 30 days**
- 10 TB — **£1.25/hr** or **£624.99 / 30 days**

A 500 GB Max workspace is not offered because Max already includes 1 TB.

## Hourly storage billing

Hourly storage billing continues for as long as the workspace exists, whether the GPU is running, stopped or released.

## 30-day prepaid storage

The 30-day prepaid option is a separate commitment product. The customer pays for the selected storage capacity for a 30-day period up front. The prepaid price contains extra commercial margin because the platform receives committed revenue and can plan storage capacity more predictably.

Prepaid storage does not include unlimited snapshots, backups, bandwidth, API operations or other services unless explicitly stated elsewhere in the platform terms.

## Storage cost architecture

Persistent workspace data should use a durable storage layer that allows the platform to keep a workspace alive without a GPU remaining active. The implementation may combine durable persistent backing with active GPU-attached block storage/cache when required.

```text
Workspace
    |
    +---- durable persistent backing
    |
    +---- active GPU-attached storage/cache when required
```

This avoids paying for fully active high-performance compute storage while the customer's GPU is stopped.

## Storage pricing review

The published storage price remains fixed between catalogue reviews. Management should review actual storage economics periodically, including durable-storage cost, requests, snapshots, restoration, regional variation, payment fees, refunds, tax and operating reserve.


# 8. Persistent versus ephemeral storage

## Persistent storage

Use persistent storage for:

- customer project files
- datasets
- checkpoints
- model/data files where relevant to the customer's own workload
- application files
- backups where supported

## Ephemeral storage

Use instance-local temporary storage for:

- scratch data
- temporary downloads
- build caches
- short-lived temporary files

Never promise that ephemeral instance storage survives instance termination.

---

# 9. GPU tier philosophy

GPU tiers are **access/performance categories**. A specific GPU family is not permanently locked to only one tier.

The initial tier assignment is:

| Tier | Positioning | GPU families |
|---|---|---|
| **Starter** | Entry GPU compute | T4, entry L4 |
| **Standard** | General-purpose GPU compute | L4, A10G |
| **Pro** | Higher-performance GPU compute | A10G, L40S |
| **Ultra** | Premium/high-memory GPU compute | L40S, A100, H100 |

The same physical GPU family may therefore appear in more than one subscription's accessible catalogue, while the actual hardware configuration remains defined once in the backend.

---

# 10. GPU product catalogue — no subscription tiers applied here

The hardware catalogue is maintained independently of subscription access. Each configuration has a fixed public product name, GPU count, vCPU count, VRAM, AWS instance mapping and fixed customer-facing base price.

The launch pricing tables below include explicit business economics so the catalogue is not just a summary of hardware.

## 10.1 NVIDIA T4

| Product name | AWS instance | GPUs | vCPU | VRAM | AWS cost/hr (USD) | AWS cost/hr (GBP planning) | Fixed base price/hr | Stripe reserve/hr* | Platform allowance/hr | Pre-tax contribution/hr | Corp Tax reserve/hr | Post-Corp-Tax contribution/hr | Owner/business amount after company tax |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **T4 Nano — 4 vCPU / 16 GB VRAM** | `g4dn.xlarge` | 1 | 4 | 16 GB | $0.5260 | £0.39 | **£1.18** | £0.04 | £0.05 | £0.70 | £0.13 | £0.57 | **£0.57** |
| **T4 Small — 8 vCPU / 16 GB VRAM** | `g4dn.2xlarge` | 1 | 8 | 16 GB | $0.7520 | £0.56 | **£1.67** | £0.05 | £0.05 | £1.01 | £0.19 | £0.82 | **£0.82** |
| **T4 Medium — 16 vCPU / 16 GB VRAM** | `g4dn.4xlarge` | 1 | 16 | 16 GB | $1.2040 | £0.89 | **£2.68** | £0.08 | £0.05 | £1.65 | £0.31 | £1.34 | **£1.34** |
| **T4 Large — 32 vCPU / 16 GB VRAM** | `g4dn.8xlarge` | 1 | 32 | 16 GB | $2.1760 | £1.61 | **£4.80** | £0.15 | £0.05 | £2.98 | £0.57 | £2.42 | **£2.42** |
| **T4 4GPU — 48 vCPU / 64 GB VRAM** | `g4dn.12xlarge` | 4 | 48 | 64 GB | $3.9120 | £2.90 | **£8.68** | £0.27 | £0.05 | £5.45 | £1.04 | £4.42 | **£4.42** |
| **T4 XL — 64 vCPU / 16 GB VRAM** | `g4dn.16xlarge` | 1 | 64 | 16 GB | $4.3520 | £3.23 | **£9.62** | £0.30 | £0.05 | £6.04 | £1.15 | £4.89 | **£4.89** |
| **T4 8GPU — 96 vCPU / 128 GB VRAM** | `g4dn.metal` | 8 | 96 | 128 GB | $7.8240 | £5.81 | **£17.35** | £0.55 | £0.05 | £10.95 | £2.08 | £8.87 | **£8.87** |

## 10.2 NVIDIA A10G

| Product name | AWS instance | GPUs | vCPU | VRAM | AWS cost/hr (USD) | AWS cost/hr (GBP planning) | Fixed base price/hr | Stripe reserve/hr* | Platform allowance/hr | Pre-tax contribution/hr | Corp Tax reserve/hr | Post-Corp-Tax contribution/hr | Owner/business amount after company tax |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A10G Nano — 4 vCPU / 24 GB VRAM** | `g5.xlarge` | 1 | 4 | 24 GB | $1.0060 | £0.75 | **£2.23** | £0.07 | £0.05 | £1.36 | £0.26 | £1.10 | **£1.10** |
| **A10G Small — 8 vCPU / 24 GB VRAM** | `g5.2xlarge` | 1 | 8 | 24 GB | $1.2120 | £0.90 | **£2.68** | £0.08 | £0.05 | £1.65 | £0.31 | £1.33 | **£1.33** |
| **A10G Medium — 16 vCPU / 24 GB VRAM** | `g5.4xlarge` | 1 | 16 | 24 GB | $1.6240 | £1.21 | **£3.57** | £0.11 | £0.05 | £2.20 | £0.42 | £1.78 | **£1.78** |
| **A10G Large — 32 vCPU / 24 GB VRAM** | `g5.8xlarge` | 1 | 32 | 24 GB | $2.4480 | £1.82 | **£5.36** | £0.17 | £0.05 | £3.32 | £0.63 | £2.69 | **£2.69** |
| **A10G 4GPU — 48 vCPU / 96 GB VRAM** | `g5.12xlarge` | 4 | 48 | 96 GB | $5.6720 | £4.21 | **£12.31** | £0.39 | £0.05 | £7.66 | £1.46 | £6.21 | **£6.21** |
| **A10G XL — 64 vCPU / 24 GB VRAM** | `g5.16xlarge` | 1 | 64 | 24 GB | $4.0960 | £3.04 | **£8.95** | £0.28 | £0.05 | £5.58 | £1.06 | £4.52 | **£4.52** |
| **A10G 4GPU XL — 96 vCPU / 96 GB VRAM** | `g5.24xlarge` | 4 | 96 | 96 GB | $8.1440 | £6.04 | **£17.91** | £0.56 | £0.05 | £11.25 | £2.14 | £9.11 | **£9.11** |
| **A10G 8GPU — 192 vCPU / 192 GB VRAM** | `g5.48xlarge` | 8 | 192 | 192 GB | $16.2880 | £12.09 | **£35.83** | £1.13 | £0.05 | £22.57 | £4.29 | £18.28 | **£18.28** |

## 10.3 NVIDIA L4

| Product name | AWS instance | GPUs | vCPU | VRAM | AWS cost/hr (USD) | AWS cost/hr (GBP planning) | Fixed base price/hr | Stripe reserve/hr* | Platform allowance/hr | Pre-tax contribution/hr | Corp Tax reserve/hr | Post-Corp-Tax contribution/hr | Owner/business amount after company tax |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **L4 Nano — 4 vCPU / 24 GB VRAM** | `g6.xlarge` | 1 | 4 | 24 GB | $0.8048 | £0.60 | **£1.78** | £0.06 | £0.05 | £1.08 | £0.20 | £0.87 | **£0.87** |
| **L4 Small — 8 vCPU / 24 GB VRAM** | `g6.2xlarge` | 1 | 8 | 24 GB | $0.9776 | £0.73 | **£2.17** | £0.07 | £0.05 | £1.33 | £0.25 | £1.07 | **£1.07** |
| **L4 Medium — 16 vCPU / 24 GB VRAM** | `g6.4xlarge` | 1 | 16 | 24 GB | $1.3232 | £0.98 | **£2.93** | £0.09 | £0.05 | £1.81 | £0.34 | £1.46 | **£1.46** |
| **L4 Large — 32 vCPU / 24 GB VRAM** | `g6.8xlarge` | 1 | 32 | 24 GB | $2.0144 | £1.49 | **£4.47** | £0.14 | £0.05 | £2.78 | £0.53 | £2.26 | **£2.26** |
| **L4 4GPU — 48 vCPU / 96 GB VRAM** | `g6.12xlarge` | 4 | 48 | 96 GB | $4.6016 | £3.41 | **£10.07** | £0.32 | £0.05 | £6.29 | £1.19 | £5.09 | **£5.09** |
| **L4 XL — 64 vCPU / 24 GB VRAM** | `g6.16xlarge` | 1 | 64 | 24 GB | $3.3968 | £2.52 | **£7.27** | £0.23 | £0.05 | £4.47 | £0.85 | £3.62 | **£3.62** |
| **L4 4GPU XL — 96 vCPU / 96 GB VRAM** | `g6.24xlarge` | 4 | 96 | 96 GB | $6.6752 | £4.95 | **£14.55** | £0.46 | £0.05 | £9.09 | £1.73 | £7.36 | **£7.36** |
| **L4 8GPU — 192 vCPU / 192 GB VRAM** | `g6.48xlarge` | 8 | 192 | 192 GB | $13.3504 | £9.91 | **£29.11** | £0.92 | £0.05 | £18.24 | £3.47 | £14.77 | **£14.77** |

## 10.4 NVIDIA L40S

| Product name | AWS instance | GPUs | vCPU | VRAM | AWS cost/hr (USD) | AWS cost/hr (GBP planning) | Fixed base price/hr | Stripe reserve/hr* | Platform allowance/hr | Pre-tax contribution/hr | Corp Tax reserve/hr | Post-Corp-Tax contribution/hr | Owner/business amount after company tax |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **L40S Nano — 4 vCPU / 48 GB VRAM** | `g6e.xlarge` | 1 | 4 | 48 GB | $1.8610 | £1.38 | **£4.13** | £0.13 | £0.05 | £2.57 | £0.49 | £2.08 | **£2.08** |
| **L40S Small — 8 vCPU / 48 GB VRAM** | `g6e.2xlarge` | 1 | 8 | 48 GB | $2.2421 | £1.66 | **£4.98** | £0.16 | £0.05 | £3.11 | £0.59 | £2.52 | **£2.52** |
| **L40S Medium — 16 vCPU / 48 GB VRAM** | `g6e.4xlarge` | 1 | 16 | 48 GB | $3.0042 | £2.23 | **£6.66** | £0.21 | £0.05 | £4.17 | £0.79 | £3.38 | **£3.38** |
| **L40S Large — 32 vCPU / 48 GB VRAM** | `g6e.8xlarge` | 1 | 32 | 48 GB | $4.5286 | £3.36 | **£10.07** | £0.32 | £0.05 | £6.34 | £1.21 | £5.14 | **£5.14** |
| **L40S XL — 64 vCPU / 48 GB VRAM** | `g6e.16xlarge` | 1 | 64 | 48 GB | $7.5772 | £5.62 | **£16.79** | £0.53 | £0.05 | £10.59 | £2.01 | £8.58 | **£8.58** |
| **L40S 4GPU — 48 vCPU / 192 GB VRAM** | `g6e.12xlarge` | 4 | 48 | 192 GB | $10.4926 | £7.79 | **£23.51** | £0.74 | £0.05 | £14.93 | £2.84 | £12.10 | **£12.10** |
| **L40S 4GPU XL — 96 vCPU / 192 GB VRAM** | `g6e.24xlarge` | 4 | 96 | 192 GB | $15.0656 | £11.18 | **£33.59** | £1.06 | £0.05 | £21.30 | £4.05 | £17.26 | **£17.26** |
| **L40S 8GPU — 192 vCPU / 384 GB VRAM** | `g6e.48xlarge` | 8 | 192 | 384 GB | $30.1312 | £22.36 | **£67.19** | £2.12 | £0.05 | £42.67 | £8.11 | £34.56 | **£34.56** |

## 10.5 NVIDIA A100

| Product name | AWS instance | GPUs | vCPU | VRAM | AWS cost/hr (USD) | AWS cost/hr (GBP planning) | Fixed base price/hr | Stripe reserve/hr* | Platform allowance/hr | Pre-tax contribution/hr | Corp Tax reserve/hr | Post-Corp-Tax contribution/hr | Owner/business amount after company tax |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **A100 8GPU — 96 vCPU / 320 GB VRAM** | `p4d.24xlarge` | 8 | 96 | 320 GB | $21.9576 | £16.29 | **£48.72** | £1.53 | £0.05 | £30.84 | £5.86 | £24.98 | **£24.98** |

The A100 product is an 8-GPU configuration. It is not offered as eight independent 1-GPU rentals in this catalogue.

## 10.6 NVIDIA H100

| Product name | AWS instance | GPUs | vCPU | VRAM | AWS cost/hr (USD) | AWS cost/hr (GBP planning) | Fixed base price/hr | Stripe reserve/hr* | Platform allowance/hr | Pre-tax contribution/hr | Corp Tax reserve/hr | Post-Corp-Tax contribution/hr | Owner/business amount after company tax |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **H100 Nano — 16 vCPU / 80 GB VRAM** | `p5.4xlarge` | 1 | 16 | 80 GB | $6.8800 | £5.10 | **£15.23** | £0.48 | £0.05 | £9.60 | £1.82 | £7.77 | **£7.77** |
| **H100 8GPU — 192 vCPU / 640 GB VRAM** | `p5.48xlarge` | 8 | 192 | 640 GB | $55.0400 | £40.84 | **£121.52** | £3.83 | £0.05 | £76.80 | £14.59 | £62.21 | **£62.21** |

---


# 11. GPU price policy

Customer-facing GPU prices are fixed launch base prices. A separate regional service premium may be added. Public base prices do not automatically change every time AWS changes a public hourly rate.

## Why prices are higher than the earlier draft

The GPU base prices were increased by approximately **12%** from the previous launch values. This is a commercial buffer added so the product price has room for payment processing, tax, failed starts, refunds and continued platform operation.

This is **not** because Stripe charges a 12% tax. Stripe is a payment processor, not HMRC. Current Stripe UK standard card pricing is 1.5% + £0.20 per UK transaction; EEA cards are 2.5% + £0.20 and international cards are 3.15% + £0.20. International transactions that require currency conversion can add 2%.

## Tax-aware pricing model

The table economics use the following planning model:

```text
Fixed GPU retail price
        - Stripe percentage reserve (3.15% planning rate)
        - AWS baseline cost converted to GBP
        - £0.05/hr platform allowance
        = pre-tax contribution

pre-tax contribution
        - 19% Corporation Tax planning reserve
        = post-Corporation-Tax contribution
```

The 3.15% Stripe reserve is a conservative percentage reserve based on the published international card rate. The fixed 20p transaction fee is not multiplied into every billed hour because it is charged per payment transaction, not per hour; it should instead be amortised through sensible wallet top-up sizes.

The 19% tax reserve is based on the 2026 UK small-profits Corporation Tax rate. The company must recalculate its actual tax from its accounts. Corporation Tax is 25% for profits above £250,000, with marginal relief between £50,000 and £250,000, so the 19% figure is an early-stage planning assumption, not a permanent business tax rate.

## Personal income tax is separate

The owner's personal Income Tax is **not a Stripe charge** and is not a fixed percentage of every GPU sale. It depends on the owner's total taxable income and on whether money is taken as salary, dividends or another permitted method.

For internal founder cash planning only, a separate personal-tax reserve can be kept after company-level taxes. The document uses **20% as a temporary planning buffer**, not as a statement of the owner's legal tax rate. HMRC's 2026–27 standard personal allowance is £12,570, and England's main non-savings Income Tax bands are 20%, 40% and 45% after the relevant allowance.

## Company versus owner money

```text
Customer payment
      |
      +---- Stripe/payment cost
      |
      +---- AWS + storage + platform operating cost
      |
      +---- Corporation Tax reserve
      |
      v
Company cash after company-level obligations
      |
      +---- development / working-capital needs
      +---- owner payment when cash flow supports it
      |
      v
Owner personal tax calculated separately
```

## Wallet top-up example

For a £10 standard UK card top-up, Stripe's published 1.5% + £0.20 rate would be approximately £0.35, leaving approximately £9.65 before other business costs. The £0.20 is a transaction fee, not a tax.

A sensible minimum wallet top-up can therefore reduce the relative effect of Stripe's fixed fee.

## Safe-cost policy

The production control plane should keep an internal safe infrastructure cost for each GPU configuration. If a region becomes too expensive, the scheduler should try another supported region. If no safe supported region remains, that configuration should be temporarily unavailable instead of being silently rented at an infrastructure loss.

*All post-Corporation-Tax contribution values in the tables are planning figures, not guaranteed profit or personal income.*

---


# 12. Regional service premiums

The base GPU price remains fixed. A separate fixed regional service premium is added where applicable. Regional premiums are intended to cover regional AWS economics, capacity scarcity and the cost of providing that location while keeping the core GPU product price stable.

## Launch regions

| Region | AWS code | Role |
|---|---|---|
| **US East (N. Virginia)** | `us-east-1` | Primary global GPU hub / baseline |
| **US West (Oregon)** | `us-west-2` | US secondary / overflow |
| **EU North (Stockholm)** | `eu-north-1` | Primary EU GPU hub |
| **UK London** | `eu-west-2` | UK customer capacity |
| **EU Central (Frankfurt)** | `eu-central-1` | Central European capacity |
| **Asia Pacific Tokyo** | `ap-northeast-1` | Asia capacity |

## GPU family regional premiums — 1-GPU baseline examples

| GPU family | US East | US West | Stockholm | London | Frankfurt | Tokyo |
|---|---:|---:|---:|---:|---:|---:|
| **T4** | £0.00 | £0.00 | +£0.08 | +£0.22 | +£0.27 | +£0.28 |
| **A10G** | £0.00 | £0.00 | +£0.12 | +£0.56 | +£0.53 | +£0.69 |
| **L4** | £0.00 | £0.00 | +£0.08 | +£0.34 | +£0.31 | +£0.56 |
| **L40S** | £0.00 | £0.00 | +£0.17 | N/A | +£0.72 | +£1.29 |
| **A100 8GPU** | £0.00 | £0.00 | +£2.69 | +£10.14 | +£8.40 | +£12.51 |
| **H100 1GPU** | £0.00 | £0.00 | N/A | +£3.17 | N/A | +£2.64 |
| **H100 8GPU** | £0.00 | £0.00 | +£5.90 | +£25.36 | N/A | +£21.03 |

The published table is a launch planning schedule. Multi-GPU configurations should use exact per-configuration regional premiums in the backend rather than blindly multiplying the 1-GPU premium by GPU count.

A region marked `N/A` must not be offered for that GPU configuration.


# 13. Automatic region and Availability Zone selection

Customers select a GPU, not an AWS region.

They may optionally provide a location preference such as:

- Automatic
- UK
- Europe
- North America
- Asia

Automatic is the default.

## Scheduler flow

```text
Customer requests GPU
        |
        v
Check subscription access
        |
        v
Check wallet / reserve
        |
        v
Find supported regions
        |
        v
Check GPU capacity
        |
        v
Check compatible AMI
        |
        v
Check persistent storage support
        |
        v
Check SSH provisioning support
        |
        v
Estimate startup time
        |
        v
Check safe infrastructure cost
        |
        v
Select region + Availability Zone
        |
        v
Provision
```

The scheduler should prioritise:

1. viable capacity;
2. compatible environment/AMI;
3. acceptable startup time;
4. customer location preference;
5. infrastructure economics;
6. balanced use of the platform's available capacity.

The exact scoring algorithm can evolve without changing the customer-facing catalogue.

---

# 14. Estimated startup time

The customer should see an estimated startup time rather than simply "available".

Example:

```text
L40S Large
Status: Available
Estimated startup: ~50 seconds
Region: Automatically selected
```

The estimate should be based on measured platform data such as:

```text
queue time
+
EC2 launch time
+
AMI boot time
+
storage attach time
+
SSH readiness
+
GPU health check
```

Store at least:

- recent average startup time;
- P50 startup time;
- P95 startup time;
- current queued requests;
- capacity state.

These estimates should be displayed as estimates, not guaranteed promises.

---

# 15. AWS AMI and environment profiles

## Primary GPU AMI

**Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.13 (Amazon Linux 2023)**

The platform should resolve the compatible regional AMI through AWS Systems Manager Parameter Store rather than hard-coding one AMI ID globally.

```text
Requested region
      |
      v
SSM parameter lookup
      |
      v
Latest compatible regional GPU AMI
      |
      v
EC2 launch
```

Use the regional SSM parameter:

```text
oss-nvidia-driver-gpu-pytorch-2.13-amazon-linux-2023/latest/ami-id
```

AMI IDs are regional and must not be copied blindly between regions.

## Environment profile

Each GPU configuration should reference a compatible environment profile.

```text
Environment profile
├── OS
├── architecture
├── AMI resolution rule
├── NVIDIA driver compatibility
├── Docker/NVIDIA Container Toolkit support
├── SSH configuration
├── storage requirements
└── health checks
```

A region is not eligible merely because AWS exposes the requested GPU there; the platform also needs a supported environment profile.

---

# 16. SSH provisioning

SSH should become available automatically after the GPU passes its readiness checks.

```text
Workspace selected
       |
       v
Public SSH key selected
       |
       v
EC2 provisioned
       |
       v
Public key injected
       |
       v
Instance booted
       |
       v
SSH readiness check
       |
       v
GPU health check
       |
       v
Workspace READY
```

The dashboard should provide connection information such as:

```text
Status: READY
Region: Automatically selected

SSH:
ssh <username>@<address>
```

The platform should retain the workspace's SSH identity even when the underlying GPU instance is terminated.

---

# 17. Dedicated GPU lifecycle

Dedicated GPU mode reserves an exclusive GPU allocation for one customer.

```text
Customer requests GPU
       |
       v
Subscription check
       |
       v
Wallet check
       |
       v
Automatic region selection
       |
       v
Capacity reservation
       |
       v
AMI resolution
       |
       v
EC2 launch
       |
       v
Persistent workspace attached
       |
       v
SSH key provisioned
       |
       v
Health checks
       |
       v
READY
       |
       v
Hourly billing
       |
       v
Customer releases GPU
       |
       v
GPU terminated / stopped
       |
       v
Workspace remains
```

Dedicated GPUs should have higher customer pricing than ordinary shared/on-demand capacity because capacity is reserved exclusively for the customer.

---

# 18. GPU rental lifecycle

```text
Customer selects GPU
       |
       v
Check subscription access
       |
       v
Check wallet reserve
       |
       v
Find viable region/AZ
       |
       v
Check compatible AMI
       |
       v
Estimate startup time
       |
       v
Check safe infrastructure cost
       |
       v
Provision EC2
       |
       v
Attach persistent workspace
       |
       v
Provision SSH access
       |
       v
Run health checks
       |
       v
Return connection details
       |
       v
Meter usage
       |
       v
Customer releases rental
       |
       v
Stop / terminate GPU
       |
       v
Keep workspace until customer deletes it
```

---

# 19. GPU availability and safe-cost policy

The platform should not promise that every GPU is available in every region.

The catalogue is made from the intersection of:

```text
GPU configuration
+
AWS regional availability
+
AMI compatibility
+
Storage compatibility
+
SSH compatibility
+
Current capacity
+
Safe infrastructure cost
```

If a GPU becomes expensive in one region:

```text
Region cost rises
       |
       v
Check safe-cost threshold
       |
       +---- still safe -> continue using region
       |
       +---- unsafe -> try another supported region
```

If no supported region is within the safe-cost threshold:

```text
Temporarily unavailable
```

The system should not silently run a GPU at a loss merely to preserve an availability label.

---

# 20. Minimum rental and billing granularity

Every GPU configuration should define a `minimum_rental` value.

Initial planning rule:

```text
Normal GPU rentals:
minimum 1 hour
```

High-cost GPUs such as A100/H100 may also require stronger wallet reserves before launch.

Actual billing granularity can be refined during implementation, but the customer-facing minimum must be explicit before launch.

---

# 21. Backend GPU catalogue schema

Each GPU configuration should be represented internally by data similar to:

```text
gpu_config_id
public_name
subscription_access
tier

aws_family
aws_instance_type
gpu_model
gpu_count
vcpus
system_ram_gib
vram_gb

base_aws_cost
base_retail_price
contribution_target
safe_infrastructure_cost

region_availability
availability_zone_availability
regional_addon

supported_ami_profile
supported_architecture

estimated_start_seconds
p50_start_seconds
p95_start_seconds

persistent_storage_supported
minimum_rental
pricing_mode
status
```

The frontend must never be the source of truth for cost, permissions or available capacity.

---

# 22. Workspace data model

A workspace record should contain at least:

```text
workspace_id
customer_id
workspace_name
plan
storage_capacity_gb
storage_volume_id
ssh_identity_id
status
created_at
updated_at
deleted_at
```

GPU rentals reference the workspace but do not own it.

```text
Workspace
   |
   +---- GPU Rental A
   |
   +---- GPU Rental B
   |
   +---- GPU Rental C
```

Only one active compute attachment should normally use a workspace at a time unless the platform explicitly supports a multi-GPU/multi-node workspace.

---

# 23. Region data model

Each supported region should have a record similar to:

```text
region_id
aws_region_code
public_name
country_or_area
supported_gpu_families
supported_ami_profiles
storage_support
ssh_support
status
regional_pricing_policy
```

Availability is dynamic. The region record describes what the platform supports; the scheduler checks what is actually available now.

---

# 24. Fixed base price versus regional premium

The customer price should be transparent but stable.

```text
GPU fixed base price
        +
Regional service premium
        +
Optional dedicated-capacity premium
        =
Customer hourly price
```

Example:

```text
L4 Small base price:
£1.81/hr

London regional premium:
+£0.30/hr

Customer price:
£2.11/hr
```

The underlying AWS price is an internal infrastructure input. It should not directly rewrite the public catalogue on every AWS price change.

---

# 25. Subscription storage and workspace anti-abuse rules

Free storage is intentionally useful but bounded.

```text
Free:
1 × 50 GB workspace
```

A customer cannot create unlimited free environments.

The same rule applies to paid plans:

```text
Pro:   5 × 500 GB
Ultra: 10 × 500 GB
Max:   15 × 1 TB
```

Workspace slots are hard account limits.

Deleting a workspace releases the slot.

Persistent data is deleted only when the workspace/storage is explicitly deleted according to the platform's deletion policy.

---

# 26. Security principles

The platform should:

- keep private SSH credentials under secure control;
- inject only the required public key material into GPU instances;
- isolate customer workloads from one another;
- avoid exposing internal AWS credentials to customers;
- avoid making the EC2 instance the source of truth for customer identity;
- remove access when a workspace is deleted;
- maintain auditable provisioning and billing events.

Customers should receive controlled access to their GPU rather than unrestricted access to the platform's AWS account.

---

# 27. Product pricing, plan descriptions and business allocation

The subscription is a recurring access product. GPU compute remains separately metered through the customer's wallet.

## Plan prices

| Plan | Monthly price |
|---|---:|
| **Free** | **£0/month** |
| **Pro** | **£35/month** |
| **Ultra** | **£65/month** |
| **Max** | **£100/month** |

Plan prices are intentionally **not increased for Stripe fees**. The platform absorbs the payment fee from plan revenue and keeps these subscription prices fixed.

## Plan descriptions

### Free — £0/month

Includes:

- **1 free 50 GB workspace**;
- Starter GPU access;
- persistent SSH identity per workspace;
- persistent workspace storage;
- paid 100 GB and 250 GB workspace upgrades;
- wallet-based GPU billing.

GPU compute is never free. The Free plan only provides the account/workspace entitlement; every GPU rental is metered and paid.

### Pro — £35/month

Includes:

- **5 free 500 GB workspaces**;
- Starter + Standard GPU access;
- dedicated GPU access;
- persistent SSH identity per workspace;
- paid 1 TB, 2 TB and 5 TB storage upgrades;
- higher account and concurrent-resource limits.

### Ultra — £65/month

Includes:

- **10 free 500 GB workspaces**;
- Starter + Standard + Pro GPU access;
- dedicated GPU access;
- persistent SSH identity per workspace;
- paid 1 TB, 2 TB and 5 TB storage upgrades;
- higher account and concurrent-resource limits than Pro.

### Max — £100/month

Includes:

- **15 free 1 TB workspaces**;
- access to all GPU tiers and configurations;
- dedicated GPU access;
- persistent SSH identity per workspace;
- paid 2 TB, 5 TB and 10 TB storage upgrades;
- highest account and concurrent-resource limits;
- priority access to eligible capacity when the scheduler can provide it.

## Explicit plan cash allocation

The platform should use fixed £ amounts rather than a percentage-allocation rule. The example below is based on a standard UK card payment and a 19% Corporation Tax planning reserve.

| Plan | Customer price | Stripe example | Business operating reserve | Company-tax reserve | Owner-available planning amount | Temporary 20% personal-tax reserve | Illustrative amount after personal-tax reserve |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Free** | £0.00 | £0.00 | £0.00 | £0.00 | **£0.00** | £0.00 | **£0.00** |
| **Pro** | £35.00 | £0.73 | £15.00 | £3.66 | **£15.61** | £3.12 | **£12.49** |
| **Ultra** | £65.00 | £1.18 | £25.00 | £7.38 | **£31.44** | £6.29 | **£25.15** |
| **Max** | £100.00 | £1.70 | £35.00 | £12.03 | **£51.27** | £10.25 | **£41.02** |

The owner-available amount is a planning figure, not guaranteed net personal income. The separate 20% personal-tax line is only a temporary cash-reserve assumption until the founder's accountant confirms the actual salary/dividend/tax position.

## GPU and storage cash allocation

For metered GPU and storage products, the business should retain only what is required to keep the service operating, cover payment leakage, meet tax obligations and absorb ordinary reliability risk. The remaining post-tax contribution can support development or be paid to the owner when cash flow safely permits.

### Priority order

```text
1. AWS GPU and storage infrastructure
2. Payment-processing costs
3. £0.05/hr platform operating allowance where applicable
4. Corporation Tax reserve
5. Refund / chargeback / working-capital reserve
6. Platform development and reliability improvements
7. Owner payment when sustainable
8. Remaining cash retained in the company
```

## Actual company result

```text
GPU revenue
+ storage revenue
+ subscription revenue
+ other permitted revenue
- Stripe/payment fees
- AWS GPU cost
- storage cost
- networking/data-transfer cost
- software/control-plane cost
- refunds/credits/chargebacks
- other allowable operating expenses
= taxable company profit

Taxable company profit
- Corporation Tax
= company profit after Corporation Tax
```

Personal Income Tax is then assessed separately on money actually paid to the owner.

## Founder capital

Initial founder capital is **£100**, dedicated to paid GPU-rental infrastructure/services including GPU capacity, SSH-related infrastructure, storage and domain. Render, Neon and Vercel application hosting are not counted in this £100 infrastructure budget under the current plan.

The domain planning cost is **£1/month**. The initial £100 is business/infrastructure funding, not owner income.


# 28. Recommended launch regions

The initial six-region fleet is:

```text
us-east-1   US East (N. Virginia)
us-west-2   US West (Oregon)
eu-north-1  EU North (Stockholm)
eu-west-2   UK London
eu-central-1 EU Central (Frankfurt)
ap-northeast-1 Asia Pacific (Tokyo)
```

### Role of each region

**US East (N. Virginia)**

Primary global GPU hub and base pricing region.

**US West (Oregon)**

Secondary US hub and overflow/redundancy region.

**EU North (Stockholm)**

Primary EU GPU hub, particularly useful for cost/coverage balance.

**UK London**

UK customer capacity and low-latency UK service.

**EU Central (Frankfurt)**

Central European capacity and fallback.

**Asia Pacific (Tokyo)**

Asia capacity and regional latency option.

Customers should normally see only a location preference, not raw AWS infrastructure choices.

---

# 29. Customer dashboard model

The customer dashboard should show product information in cloud-native language rather than requiring AWS knowledge.

Example:

```text
L40S Large
1 × NVIDIA L40S
32 vCPU
48 GB VRAM

Status:
AVAILABLE

Estimated startup:
~50 seconds

Location:
Automatically selected

Workspace:
Project Alpha — 500 GB

Price:
£8.37/hr base
+ regional premium
```

After launch:

```text
Status:
READY

Region:
Automatically selected

SSH:
ssh <username>@<address>

Workspace:
Project Alpha

Persistent storage:
500 GB

Billing:
£X.XX/hr
```

---

# 30. Customer journey

```text
1. Customer creates account
        |
2. Selects subscription
        |
3. Creates persistent workspace
        |
4. Chooses included or paid storage size
        |
5. Adds SSH identity
        |
6. Adds wallet funds when GPU usage is needed
        |
7. Selects GPU configuration
        |
8. Platform automatically selects region/AZ
        |
9. Platform selects compatible AMI
        |
10. EC2 GPU is launched
        |
11. Workspace and persistent storage attach
        |
12. SSH public key is provisioned
        |
13. Health checks pass
        |
14. Customer receives SSH details
        |
15. GPU usage is metered
        |
16. Customer releases GPU
        |
17. GPU stops/terminates
        |
18. Workspace remains
        |
19. Customer can reuse workspace later
```

---

# 31. Final plan summary

| Plan | Price | Workspaces | Included storage | GPU access |
|---|---:|---:|---:|---|
| **Free** | **£0/month** | **1 × 50 GB workspace** | 50 GB | Starter |
| **Pro** | **£35/month** | **5 × 500 GB workspaces** | 500 GB each | Starter + Standard |
| **Ultra** | **£65/month** | **10 × 500 GB workspaces** | 500 GB each | Starter + Standard + Pro |
| **Max** | **£100/month** | **15 × 1 TB workspaces** | 1 TB each | All GPU tiers |

## Plan summary and value proposition

| Plan | Description | Monthly |
|---|---|---:|
| **Free** | Entry plan with 1 persistent 50 GB workspace and Starter GPU access. GPU compute is always metered and paid. | **£0** |
| **Pro** | Regular developer plan with 5 persistent 500 GB workspaces and Starter + Standard GPU access. | **£35** |
| **Ultra** | Power-user plan with 10 persistent 500 GB workspaces and Starter + Standard + Pro GPU access. | **£65** |
| **Max** | Full professional plan with 15 persistent 1 TB workspaces and access to the complete GPU catalogue. | **£100** |

# 32. Final storage summary

### Free

```text
1 × 50 GB workspace included

Paid upgrades:
100 GB  → £0.02/hr or £9.99 / 30 days
250 GB  → £0.04/hr or £19.99 / 30 days
```

### Pro

```text
5 × 500 GB workspaces included

Paid upgrades:
1 TB  → £0.14/hr or £69.99 / 30 days
2 TB  → £0.27/hr or £134.99 / 30 days
5 TB  → £0.65/hr or £324.99 / 30 days
```

### Ultra

```text
10 × 500 GB workspaces included

Paid upgrades:
1 TB  → £0.14/hr or £69.99 / 30 days
2 TB  → £0.27/hr or £134.99 / 30 days
5 TB  → £0.65/hr or £324.99 / 30 days
```

### Max

```text
15 × 1 TB workspaces included

Paid upgrades:
2 TB   → £0.27/hr or £134.99 / 30 days
5 TB   → £0.65/hr or £324.99 / 30 days
10 TB  → £1.25/hr or £624.99 / 30 days
```

Storage billing is independent of GPU lifecycle. Releasing/stopping a GPU stops GPU charges, not workspace storage charges. Deleting the workspace ends future storage billing.


# 33. Final GPU access summary

## Starter

Accessible to Free, Pro, Ultra and Max.

Hardware catalogue includes:

- T4 configurations
- L4 Nano

## Standard

Accessible to Pro, Ultra and Max.

Hardware catalogue includes:

- T4 configurations
- L4 configurations
- A10G configurations

## Pro

Accessible to Ultra and Max.

Hardware catalogue includes:

- T4 configurations
- L4 configurations
- A10G configurations
- L40S configurations

## Ultra

Accessible to Max.

Hardware catalogue includes:

- L40S configurations
- A100 8GPU
- H100 configurations

The hardware catalogue itself is maintained separately from subscription permissions.

---

# 34. Final product architecture

```text
                         YOUR GPU CLOUD
                               |
              +----------------+----------------+
              |                                 |
         CUSTOMER APP                     CUSTOMER SSH
              |                                 |
              +----------------+----------------+
                               |
                         CONTROL PLANE
                               |
        +----------------------+----------------------+
        |                      |                      |
     Accounts               Billing              Workspaces
        |                      |                      |
        +----------------------+----------------------+
                               |
                         GPU SCHEDULER
                               |
        +----------------------+----------------------+
        |                      |                      |
     Capacity                 AMI                Pricing
        |                 compatibility              |
        |                      |                      |
        +----------------------+----------------------+
                               |
                         PROVISIONER
                               |
     +----------------+--------+--------+----------------+
     |                |                 |                |
   AWS EC2          AWS EBS          AWS regions       AWS AZs
     |                |                 |                |
     +----------------+-----------------+----------------+
                               |
                         GPU WORKSPACE
                               |
                    +----------+----------+
                    |                     |
             Persistent storage       SSH access
```

---

# 35. Final operating principles

The platform should operate according to these rules:

1. **GPU rentals are the core product.** AI model hosting is out of scope for launch.
2. **Subscriptions buy access and workspace allowances, not unlimited compute.**
3. **GPU compute is wallet-metered.**
4. **Customers choose a GPU, not an AWS region.**
5. **The scheduler automatically chooses region and Availability Zone.**
6. **A region is eligible only when GPU, AMI, storage, SSH, startup-time and safe-cost requirements are satisfied.**
7. **Workspace storage and SSH identity persist independently of GPU lifecycle.**
8. **GPU base prices are fixed customer-facing prices and do not automatically change with every AWS price change.**
9. **Regional service premiums are separate from the base GPU price.**
10. **The platform continuously monitors infrastructure economics internally.**
11. **The platform should not launch capacity at an infrastructure cost that exceeds its safe-cost threshold.**
12. **GPU, storage and workspace revenue is used to fund direct service delivery and platform development; subscriptions are the primary source of owner compensation.**
13. **Workspace limits are hard account-level limits to prevent abuse.**
14. **The frontend is never the source of truth for pricing, permissions or capacity.**
15. **Dedicated GPU capacity is exclusive and priced separately from ordinary on-demand capacity.**
16. **Persistent workspaces are deleted separately from GPU rentals.**

---

# 36. Sources and validation notes

AWS official:

- EC2 accelerated computing specifications: https://docs.aws.amazon.com/ec2/latest/instancetypes/ac.html
- AWS EC2 G4: https://aws.amazon.com/ec2/instance-types/g4/
- AWS EC2 G6: https://aws.amazon.com/ec2/instance-types/g6/
- AWS EC2 G6e: https://aws.amazon.com/ec2/instance-types/g6e/
- AWS EC2 accelerated computing: https://aws.amazon.com/ec2/instance-types/accelerated-computing/
- AWS EC2 P4: https://aws.amazon.com/ec2/instance-types/p4/
- AWS EC2 P5: https://aws.amazon.com/ec2/instance-types/p5/
- AWS EBS volume types: https://aws.amazon.com/ebs/volume-types/
- AWS S3 pricing: https://aws.amazon.com/s3/pricing/
- AWS Deep Learning AMIs: https://docs.aws.amazon.com/dlami/latest/devguide/
- AWS EC2 purchasing options: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-purchasing-options.html
- AWS regional instance availability: https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-regions.html
- AWS current price-list files: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-aws-price-list-bulk-api-fetching-price-list-files-manually.html

Pricing/reference material used during planning:

- AWS pricing/reference pages for G4dn, G5, G6, G6e, P4d and P5
- Regional AWS pricing snapshots used to establish launch regional premiums



## Payment-processing notes

Stripe's current UK standard card pricing is 1.5% + £0.20 per transaction; EEA cards are 2.5% + £0.20 and international cards are 3.15% + £0.20, with additional fees possible for currency conversion and certain payment methods. Stripe Billing also has a 0.7% pay-as-you-go fee for Billing volume. These charges are operating costs and should be accounted for in payment/wallet economics rather than treated as VAT.

AWS currently publishes gp3 at **$0.08/GiB-month** in US East (N. Virginia), with separate charges for provisioned IOPS and throughput above the baseline. Amazon S3 pricing varies by storage class, region, request volume and data-transfer pattern. Production storage cost calculations should therefore use the platform's actual selected storage architecture and current regional AWS pricing.

> **Pricing disclaimer:** public AWS pricing and capacity change over time. The fixed base prices, storage add-on prices and regional premiums in this document are proposed launch values, not guarantees. The production billing system should maintain internal safe-cost thresholds, track actual margins and periodically review commercial pricing.
