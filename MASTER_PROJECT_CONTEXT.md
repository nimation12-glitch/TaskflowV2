# TASKFLOW — MASTER ENGINEERING & PRODUCT SPECIFICATION

You are the lead architect and senior software engineer responsible for building **TaskFlow**.

TaskFlow is intended to become a real commercial **AI cloud and AI infrastructure marketplace**, not a demo, mockup, chatbot, or generic API wrapper.

You must understand this document before modifying the codebase.

Treat this specification as the current source of truth for the product direction.

Do not silently revert to earlier assumptions about TaskFlow being only an AI API gateway.

---

# 1. TASKFLOW PRODUCT VISION

TaskFlow is an AI infrastructure platform with two major products:

## A. Shared AI platform

Customers subscribe to TaskFlow and receive access to shared AI infrastructure and AI models.

They:

* create an account
* create or join an organization/workspace
* subscribe to a plan
* receive monthly AI usage credits
* generate API keys
* access approved AI models through an OpenAI-compatible API
* consume AI usage
* monitor tokens, requests, compute and spending
* purchase additional credits when included credits are exhausted

## B. GPU infrastructure marketplace

Customers can rent GPU compute by the hour.

TaskFlow should eventually support GPU capacity from:

1. TaskFlow/AWS-owned infrastructure
2. external GPU infrastructure providers
3. community/third-party GPU workers
4. future enterprise infrastructure partners

Customers can use rented GPUs to:

* run supported open-weight models
* deploy their own legally authorized models
* expose those deployments through TaskFlow API endpoints

GPU owners should eventually be able to connect their own hardware to TaskFlow and earn money by allowing TaskFlow to schedule approved AI workloads onto their GPU.

TaskFlow therefore evolves into:

> A marketplace and control plane connecting customers, AI models and distributed GPU infrastructure.

---

# 2. CORE BUSINESS MODEL

TaskFlow makes money through multiple streams.

## Revenue stream 1 — subscriptions

Initial plans:

FREE
£0/month

PRO
£30/month

MAX
£90/month

## Revenue stream 2 — AI usage

Customers consume AI usage credits.

Usage must account for the real cost of serving inference.

Possible internal cost components include:

* input tokens
* output tokens
* model/provider cost
* GPU compute
* infrastructure
* network/storage where applicable
* TaskFlow margin

Customers see a unified AI usage charge.

Do not make customers manually calculate infrastructure costs.

## Revenue stream 3 — additional credit purchases

Customers can buy more TaskFlow credits.

Initial packages:

£10
£25
£50
£100

These must be configurable.

## Revenue stream 4 — dedicated GPU rental

Customers pay for dedicated GPU runtime.

GPU rental is billed based on runtime and the selected GPU's configured rate.

## Revenue stream 5 — GPU marketplace commission

When a third-party GPU owner supplies compute to TaskFlow customers, TaskFlow can retain a configurable percentage of the transaction.

Example concept:

Customer pays £1.20/hour.

GPU provider receives a configured provider share.

TaskFlow receives the remaining marketplace/platform share.

Do not hardcode the percentage.

## Revenue stream 6 — future business/enterprise plans

The architecture must eventually support significantly higher-value plans.

---

# 3. CAPITAL CONSTRAINT

This is a critical requirement.

Current available AWS starter credits are approximately:

$100

AWS Activate Founders application has been submitted but additional credits are NOT assumed to be available until officially approved.

Therefore:

## DO NOT

* purchase physical GPUs
* maintain a large always-on GPU fleet
* assume unlimited AWS compute
* launch expensive GPU instances without economic justification
* create infrastructure that requires thousands of pounds upfront
* run idle GPUs indefinitely
* assume TaskFlow can finance large compute purchases before customers pay

## PRINCIPLE

Customer demand should increasingly finance infrastructure.

Conceptually:

CUSTOMER PAYMENT
→
COMPUTE
→
AI SERVICE
→
REVENUE
→
MORE COMPUTE

AWS credits should be used strategically for development, testing and eventually a small seed compute deployment.

---

# 4. HOW TASKFLOW GETS AI MODELS

TaskFlow must distinguish between model sources.

There are three major categories.

## EXTERNAL_API

The model is served by a third-party provider.

Examples:

NVIDIA
Moonshot
OpenAI
OpenRouter
other legitimate providers

TaskFlow proxies or routes requests to the provider.

Example:

Kimi K3
provider = NVIDIA
hosting_mode = EXTERNAL_API

TaskFlow must NOT claim ownership of externally hosted inference.

## TASKFLOW_HOSTED

TaskFlow actually hosts the model on infrastructure controlled/managed by TaskFlow.

Conceptually:

model weights
→ storage
→ GPU
→ inference runtime
→ TaskFlow endpoint

## CUSTOMER_HOSTED

The customer supplies or references a model they are legally authorized to use.

TaskFlow deploys it onto rented/dedicated compute.

---

# 5. MODEL LICENSE AND SOURCE REQUIREMENT

Never assume "open source" means "anything is allowed."

For every model intended for commercial hosting, maintain metadata for:

* model source
* version
* license
* usage restrictions
* redistribution restrictions
* commercial-use status where known
* source URL/reference
* model artifact location
* runtime compatibility

Only advertise a model as available for commercial hosting when its licensing/terms have been appropriately reviewed.

If a model cannot legally or operationally be offered, mark it unavailable.

---

# 6. NO PLACEHOLDER AI MODELS AS LIVE PRODUCTS

The existing project may contain placeholder/demo `taskflow-*` models.

These must NOT be represented as real production hosted models unless an actual inference backend exists.

A model must have an explicit status:

LIVE
COMING_SOON
DISABLED
NOT_CONFIGURED
DEMO_ONLY

The frontend must accurately show that state.

Never fabricate successful model inference.

Never pretend a local mock model is production GPU infrastructure.

---

# 7. MODEL REGISTRY

Create a proper model registry.

Each model should support fields conceptually including:

* id
* slug
* display_name
* version
* provider_id
* model_identifier
* hosting_mode
* source
* source_url
* license
* runtime
* minimum_vram
* capabilities
* context_window
* enabled
* status
* created_at
* updated_at

Model hosting modes:

EXTERNAL_API
TASKFLOW_HOSTED
CUSTOMER_HOSTED

Model pricing must be configurable.

Model entitlements must be database-backed.

---

# 8. SUBSCRIPTION PLANS

## FREE

£0/month

Includes approximately:

* £2 monthly AI usage credits
* 20 RPM
* lowest shared compute priority
* limited model access
* basic API access
* API keys
* basic dashboard

Free credits normally expire at the end of the billing period.

Free customers do NOT get unlimited GPU compute.

## PRO

£30/month

Includes approximately:

* £15 monthly AI usage credits
* 100 RPM
* improved shared compute priority
* broader model access
* higher concurrency
* usage analytics
* GPU rental capability
* additional credit purchases

## MAX

£90/month

Includes approximately:

* £50 monthly AI usage credits
* 300 RPM
* highest shared compute priority
* premium model access
* higher concurrency
* advanced analytics
* GPU rental capability
* additional credit purchases

These are initial values and must be configurable.

Do not scatter these numbers throughout application code.

Store plan configuration in the database.

---

# 9. CREDITS

Use a customer-facing TaskFlow credit system.

Conceptually:

1 credit ≈ £1.00 of usage value.

Money must continue to use integer micro-GBP.

1,000,000 micro-GBP = £1.00

Examples:

£15 = 15,000,000 micro-GBP

£0.000494 = 494 micro-GBP

Do not use floating-point values for actual money ledger balances.

---

# 10. AI USAGE CALCULATION

AI usage is the principal variable-cost service.

The pricing engine must be flexible.

A request can incur:

input token cost

output token cost

GPU compute cost

provider cost

infrastructure cost

TaskFlow margin

The customer should receive one unified charge.

Example:

Input token cost = £0.01

Output token cost = £0.04

GPU cost = £0.08

TaskFlow margin = £0.02

Customer usage charge = £0.15

This is an example only.

DO NOT hardcode these values.

---

# 11. TOKENS AND GPU TIME MUST BE TRACKED SEPARATELY

Do not collapse them into a single metric.

Usage events should be able to contain:

* input_tokens
* output_tokens
* total_tokens
* gpu_seconds
* provider_cost
* gpu_cost
* infrastructure_cost
* margin
* customer_charge

A request may use an external provider and therefore have provider costs but no TaskFlow GPU time.

A TaskFlow-hosted model may have GPU compute costs.

A dedicated GPU rental has infrastructure runtime independently of token consumption.

---

# 12. CREDIT LEDGER

Credits require a proper append-only ledger.

Examples:

+£15.00 monthly Pro allowance

-£0.03 AI request

-£0.12 model usage

+£25.00 purchased credits

-£4.50 GPU usage

Every transaction should include enough metadata for auditing.

Do not simply mutate a balance without recording the corresponding transaction.

Credits should belong to the organization.

---

# 13. ORGANIZATION / WORKSPACE ARCHITECTURE

A User is NOT the billing entity.

A User is NOT equivalent to a workspace.

Use:

User
Organization
Membership

Every User gets a stable UUID.

Every Organization gets a stable UUID.

The organization is the primary tenant and billing entity.

Organization owns:

* subscription
* credit account
* credit ledger
* API keys
* usage
* model entitlements where appropriate
* deployments
* GPU instances
* billing relationship

---

# 14. ORGANIZATION MEMBERS

Membership connects a user to an organization.

Minimum roles:

OWNER
ADMIN
MEMBER

## FREE PLAN

Allow:

1 owner
+
2 additional invited members

Maximum:
3 total members.

The exact membership limit must be configurable by plan.

Do NOT hardcode "2" into dozens of components.

---

# 15. ORGANIZATION BILLING

Stripe customer/subscription should belong to the Organization.

Correct structure:

Organization
→ Stripe Customer
→ Subscription
→ Credit Account
→ Usage

Do not make individual users the primary billing owner.

Members share the organization's plan and credit allowance.

---

# 16. REAL AUTHENTICATION

TaskFlow needs a real account lifecycle.

Registration:

email
password
→ create User UUID
→ email verification
→ create Organization UUID
→ create OWNER membership
→ create Free subscription
→ create credit account
→ dashboard

Architecture should support:

* secure password hashing
* login
* logout
* session creation
* session revocation
* email verification
* password reset
* account status
* secure cookies/session handling
* future 2FA
* future OAuth

Do not build fake production authentication.

Development mocks must be clearly isolated to test/development environments.

---

# 17. MULTI-TENANT SECURITY

This is CRITICAL.

Every authenticated request must establish:

user
organization
membership
role

Every organization-owned resource must be scoped to the current organization.

A user must never access another organization's:

* API keys
* credits
* subscriptions
* usage
* members
* deployments
* GPU instances
* invoices
* billing records

Frontend filtering is NOT security.

Server-side authorization is mandatory.

---

# 18. API KEYS

API keys belong primarily to Organizations.

Store:

* id
* organization_id
* created_by_user_id
* name
* prefix
* hash
* status
* created_at
* last_used_at
* revoked_at
* optional permission scope
* optional deployment_id

Format example:

tf_live_...

Raw keys:

* generated cryptographically securely
* displayed exactly once
* never stored plaintext
* never logged
* never returned later in full

---

# 19. OPENAI-COMPATIBLE API

The primary customer API should remain:

POST /api/v1/chat/completions

GET /api/v1/models

Use OpenAI-compatible request/response semantics wherever practical.

Customer flow:

API key
→ authenticate
→ resolve organization
→ resolve plan
→ check model entitlement
→ check rate limit
→ check credits
→ route request
→ provider/inference
→ meter
→ charge
→ respond

---

# 20. PROVIDER ABSTRACTION

Maintain a provider interface.

Conceptually:

ProviderAdapter

Methods may include:

is_configured()
health()
chat_completion()
stream_chat_completion()
estimate_usage()
etc.

External providers should include adapters for configured services such as:

NVIDIA
Moonshot
OpenAI
OpenRouter

Do not require all providers to be configured.

If a provider is unavailable, return an honest error.

---

# 21. PROVIDER VS COMPUTE PROVIDER

These are separate concepts.

MODEL PROVIDER:

Who supplies inference/model access?

Examples:

NVIDIA
OpenAI
Moonshot

COMPUTE PROVIDER:

Who supplies GPU hardware?

Examples:

AWS
Runpod
community worker
future provider

Do NOT collapse these into one abstraction.

---

# 22. COMPUTE PROVIDER ABSTRACTION

Create:

ComputeProvider

with conceptual operations:

provision
start
stop
restart
terminate
status
health_check
attach_storage
deploy_model

Implement provider adapters independently.

Potential providers:

AWS
Runpod
other GPU clouds
CommunityWorker

Business logic should call:

compute_provider.provision(...)

not AWS-specific APIs directly.

---

# 23. AWS ROLE

AWS is an infrastructure provider.

AWS is NOT the source of every model.

AWS can host:

* TaskFlow frontend
* backend/control plane
* database depending on architecture
* S3 model storage
* ECR containers
* logging/monitoring
* secrets/IAM
* GPU compute
* networking/security infrastructure

Future hosted-model flow:

model source
→ model artifact
→ S3
→ AWS GPU
→ inference runtime
→ TaskFlow endpoint

---

# 24. INITIAL AWS STRATEGY

Current AWS budget is approximately $100 in starter credits.

Therefore:

DO NOT start a large GPU fleet.

The first objective is to establish infrastructure abstractions and perform carefully controlled testing.

When GPU hosting is first tested, use a cost-conscious GPU instance suitable for the chosen model.

Do not immediately deploy H100-class hardware.

Before launching any GPU:

calculate:

* AWS hourly cost
* expected model throughput
* VRAM requirements
* expected utilization
* expected customer price
* margin
* maximum daily spend

---

# 25. AWS GPU COMPUTE

The AWS compute adapter should eventually be capable of provisioning GPU instances such as appropriate EC2 accelerated instances.

The exact instance family must be configurable.

Potential examples include current AWS GPU instance families such as:

G6 / L4
G6e / L40S
G5 / A10G
P-series where economically justified

Do not hardcode a specific instance as "the TaskFlow GPU."

Select compute based on model requirements and economics.

---

# 26. AWS MODEL HOSTING FLOW

When TaskFlow eventually hosts a model:

1. Model is approved and licensed for commercial use.
2. Model artifact/version is registered.
3. Model is stored/cached appropriately.
4. TaskFlow requests suitable compute.
5. ComputeProvider provisions AWS GPU.
6. Model-serving runtime is started.
7. Model is loaded.
8. Health check succeeds.
9. Deployment becomes READY.
10. TaskFlow routes customer requests to deployment.
11. Usage is metered.
12. Costs are recorded.
13. GPU stops when appropriate if using a scale-down strategy.

---

# 27. DO NOT KEEP GPUs RUNNING NEEDLESSLY

GPU infrastructure is expensive.

Support lifecycle states:

REQUESTED
PROVISIONING
STARTING
RUNNING
IDLE
STOPPING
STOPPED
FAILED
TERMINATING
TERMINATED

Support configurable idle timeout.

Potential flow:

RUNNING
→ no traffic
→ IDLE
→ timeout
→ STOPPING
→ STOPPED

Do not assume a single fixed timeout is always correct.

---

# 28. DEDICATED GPU RENTALS

A customer can rent dedicated hardware.

Example UI:

RTX 4090
L4
A100
L40S
H100

Prices must be database-configurable.

Customer selects:

GPU
region
runtime
model
storage if necessary

Then:

payment/preauthorization
→ provisioning
→ model deployment
→ health check
→ endpoint
→ API key

---

# 29. DEDICATED GPU BILLING

Dedicated GPU runtime is separate from shared AI usage.

Customer may have:

subscription
+
AI usage
+
GPU rental

Example:

£90 Max subscription

*

£20 AI usage

*

£30 GPU runtime

Total:

£140

The exact pricing is configurable.

---

# 30. COMMUNITY GPU NETWORK

TaskFlow should eventually support third-party GPU owners.

A GPU owner installs a **TaskFlow Worker** on supported hardware.

The worker:

* authenticates to TaskFlow
* reports hardware
* detects GPU
* performs benchmark
* reports capacity
* maintains heartbeat
* receives approved jobs
* runs approved inference workloads
* reports usage/results
* receives payment attribution

The owner can choose when the GPU is available.

---

# 31. COMMUNITY WORKER ARCHITECTURE

Workers should use an outbound connection to TaskFlow wherever practical.

Do NOT require exposing arbitrary inbound ports to the public internet.

Conceptual flow:

Worker
→ TaskFlow: authenticate

Worker
→ TaskFlow: heartbeat

Worker
→ TaskFlow: availability

Worker
→ TaskFlow: request job

TaskFlow
→ Worker: signed/authorized inference workload

Worker
→ TaskFlow: result/status/usage

Workers should be treated as untrusted infrastructure.

---

# 32. SECURITY OF COMMUNITY GPU WORKERS

This is CRITICAL.

Never allow a customer to obtain arbitrary shell/host access to someone else's computer.

Do not execute arbitrary customer-provided code directly on the host.

Use isolation appropriate to the runtime.

Potential mechanisms include:

* containers
* restricted runtime
* signed workload definitions
* filesystem isolation
* network restrictions
* secrets isolation
* process isolation
* resource limits
* worker authentication
* job signing
* abuse detection

Community workers should initially support approved AI inference workloads rather than arbitrary compute workloads.

---

# 33. GPU OWNER VERIFICATION

When a GPU owner joins:

1. install worker
2. authenticate
3. detect GPU hardware
4. verify CUDA/runtime capability
5. run benchmark
6. report VRAM
7. report CPU/RAM/network
8. establish reliability score
9. mark worker verified/limited
10. make capacity available

Worker status should support:

PENDING
VERIFYING
ACTIVE
DEGRADED
SUSPENDED
OFFLINE
REVOKED

---

# 34. GPU MARKETPLACE

Customers should eventually see:

GPU type
VRAM
region
price/hour
availability
reliability
provider type
performance class

Example:

RTX 4090
24 GB
EU
£1.20/hr
98% reliability
Community Worker

Do not pretend marketplace prices are final.

Prices must be dynamic/configurable.

---

# 35. GPU MARKETPLACE ECONOMICS

TaskFlow should support a configurable marketplace fee.

Conceptually:

## customer price

# provider payout

TaskFlow marketplace revenue

Track:

* customer charge
* provider share
* TaskFlow share
* runtime
* marketplace transaction

Do not calculate provider payout by frontend logic.

---

# 36. SHARED COMPUTE

TaskFlow also has shared infrastructure.

Plans have priority:

FREE = lowest

PRO = normal

MAX = highest

Priority can later determine:

* queue position
* concurrency
* scheduling
* resource access
* burst limits

Free customers should not be deliberately broken.

They simply receive the least favorable resource priority.

---

# 37. GPU SCHEDULER

The future scheduler should select compute based on:

* model requirements
* VRAM
* provider
* region
* GPU availability
* customer entitlement
* workload type
* customer priority
* GPU price
* expected margin
* worker reliability
* model cache availability

Do NOT immediately implement a complicated scheduler.

Create clean abstractions first.

---

# 38. MODEL DEPLOYMENTS

A Deployment belongs to an Organization.

Track:

* id
* organization_id
* created_by_user_id
* model_id
* gpu_instance_id
* provider
* endpoint
* status
* runtime
* version
* created_at
* updated_at

Possible states:

QUEUED
PROVISIONING
DEPLOYING
STARTING
READY
DEGRADED
STOPPED
FAILED
DELETING
DELETED

---

# 39. CUSTOMER MODEL HOSTING

Customer flow:

Choose model
→ choose GPU
→ payment authorization
→ provision
→ deploy
→ health check
→ endpoint
→ API key

The customer must own/legally control the model artifact they provide.

TaskFlow must never imply that it grants a customer rights they do not have.

---

# 40. DATABASE MODEL

Core entities:

User

Organization

Membership

Plan

Subscription

CreditAccount

CreditTransaction

ApiKey

Provider

AiModel

ModelEntitlement

ModelPricing

UsageEvent

StripeCustomer

StripeEvent

Invoice

GpuType

ComputeProvider

GpuInstance

Deployment

GpuWorker

WorkerHeartbeat

GpuMarketplaceOffer

GpuRental

PayoutLedger

AuditLog

Not every entity must be implemented immediately, but the architecture should anticipate them.

---

# 41. TENANT OWNERSHIP

Resources should use organization_id where appropriate.

Examples:

ApiKey → organization_id

CreditAccount → organization_id

Subscription → organization_id

UsageEvent → organization_id

GpuInstance → organization_id when customer-owned/rented

Deployment → organization_id

Invoice → organization_id

Record user_id separately when useful for audit/attribution.

---

# 42. USAGE EVENT

UsageEvent should be able to record:

organization_id

user_id

api_key_id

model_id

provider_id

deployment_id

status

input_tokens

output_tokens

total_tokens

gpu_seconds

provider_cost_micros

gpu_cost_micros

infrastructure_cost_micros

margin_micros

charge_micros

latency_ms

timestamp

Do not accept customer-supplied pricing.

All charge calculations happen server-side.

---

# 43. BILLING SAFETY

A request that never reaches a provider should generally not be charged as successful inference.

If a provider fails after dispatch, the event should preserve failure state and only charge according to explicitly defined cost rules.

The gateway should prevent negative credit balances unless a specifically designed controlled overdraft mechanism exists.

Credit deductions must be transactional.

Concurrent requests must not bypass the balance guard.

---

# 44. STRIPE

Stripe should manage:

* subscriptions
* recurring billing
* credit purchases where appropriate
* future usage billing
* invoices
* payment state

Important events:

checkout.session.completed

invoice.paid

invoice.payment_failed

customer.subscription.updated

customer.subscription.deleted

Every webhook must:

* verify signature
* be idempotent
* record event ID
* update organization state
* avoid duplicate credit grants

---

# 45. BILLING STATE MACHINE

Organization subscription states should be synchronized from Stripe.

Possible states:

ACTIVE
TRIALING
PAST_DUE
PAYMENT_FAILED
CANCELED
INCOMPLETE

Entitlements must be determined server-side.

---

# 46. PRODUCTION VS DEVELOPMENT

Development can use simulated/test providers and Stripe test mode.

Production must not silently fall back to simulations.

A production startup should fail safely when essential secrets/configuration are missing.

Never allow:

STRIPE_SECRET_KEY missing
→ fake production subscription

Never allow:

provider missing
→ fake successful model response

Never allow:

GPU provisioning unavailable
→ pretend GPU is running

---

# 47. FRONTEND

Frontend should use:

Next.js
TypeScript
Tailwind
shadcn/ui
Recharts
Lucide

Primary pages:

/

dashboard

/dashboard/usage

/dashboard/api-keys

/dashboard/billing

/dashboard/models

/dashboard/compute

/dashboard/team

/docs

---

# 48. DASHBOARD OVERVIEW

Show:

Plan

Organization/workspace

Credit balance

AI usage

Requests

Tokens

GPU usage

Current deployments

Team count

Quick actions

Examples:

Create API key

Buy credits

Upgrade

Invite member

Rent GPU

Deploy model

---

# 49. TEAM PAGE

Show:

organization name

organization UUID where appropriate

members

roles

pending invitations

member limit

invitation controls

Free:

maximum 3 total members

Owner + 2 additional members

The backend must enforce membership limits.

---

# 50. MODELS PAGE

Show:

model name

provider

hosting mode

status

capabilities

plan requirement

approximate usage cost where appropriate

Examples:

LIVE

COMING SOON

NOT CONFIGURED

REQUIRES PRO

REQUIRES MAX

Never use frontend-only access controls.

---

# 51. COMPUTE PAGE

Show:

available GPU types

price/hour

availability

provider

region

reliability

current rentals

deployments

runtime

current cost

Controls:

Rent GPU

Start

Stop

Restart

Delete

Deploy model

---

# 52. BILLING PAGE

Show:

current plan

subscription status

monthly allowance

credits used

additional purchases

current balance

GPU charges

billing history

payment status

manage billing

---

# 53. API KEY PAGE

Show:

key name

masked key

created

last used

status

Create key

Revoke key

Creating:

generate
→ show once
→ copy
→ warning
→ never show again

---

# 54. INFRASTRUCTURE COST CONTROL

Implement configurable safeguards:

maximum GPU runtime

maximum GPU daily spend

maximum deployment count

maximum organization concurrency

maximum API requests

maximum credit usage

maximum worker concurrency

maximum worker job duration

maximum customer GPU rental duration

The system should have kill-switches for runaway infrastructure.

---

# 55. AWS SECURITY

Use least-privilege IAM.

Do not place AWS access keys in frontend code.

Use IAM roles wherever possible.

Keep compute credentials separate from application credentials.

Store secrets securely.

Do not give customer-facing requests direct AWS API access.

The TaskFlow backend is the control layer.

---

# 56. MODEL STORAGE

For TaskFlow-hosted models, use appropriate object storage/model caching.

AWS S3 can serve as a model artifact store.

Conceptually:

S3
→ model artifact
→ GPU instance
→ local cache
→ inference runtime

Do not repeatedly download large models unnecessarily.

Version model artifacts.

Track checksums where appropriate.

---

# 57. INFERENCE RUNTIME

The runtime must be chosen based on the model.

Potential technologies can include appropriate containerized inference servers.

Do not assume every model can use the same runtime.

Model metadata should identify compatible runtimes.

The architecture must permit runtime-specific deployment configuration.

---

# 58. EXTERNAL AI PROVIDERS

The external provider layer must support:

authentication
health checks
timeouts
retries where safe
streaming where supported
usage extraction
error mapping

HTTP 429s must be handled intelligently.

Do not hammer an overloaded provider with immediate retry loops.

Use bounded retries and backoff where appropriate.

---

# 59. TASKFLOW API RESPONSE

When appropriate, TaskFlow may expose metering information in a non-breaking TaskFlow-specific field.

Examples can include:

charge_micros

balance_micros

provider

latency

usage metadata

Do not break OpenAI compatibility unnecessarily.

---

# 60. OBSERVABILITY

Record:

request count

latency

model

provider

tokens

GPU seconds

customer charge

provider cost

GPU cost

errors

deployment status

worker status

Do not log:

raw API keys

passwords

provider secrets

Stripe secrets

AWS secrets

sensitive customer data unnecessarily

---

# 61. ADMIN / OPERATOR CONTROLS

Eventually provide internal administration capabilities for:

* model enable/disable
* provider health
* model pricing
* plan limits
* credit adjustments
* GPU workers
* worker suspension
* deployments
* abuse mitigation
* refunds/adjustments
* infrastructure shutdown

These must be protected by strong authorization and should not be exposed to normal customers.

---

# 62. PHASED IMPLEMENTATION

DO NOT BUILD EVERYTHING AT ONCE.

## PHASE 0 — ARCHITECTURE CORRECTION

Audit current project.

Remove or clearly mark placeholder models.

Document actual architecture.

Do not deploy GPUs.

## PHASE 1 — IDENTITY AND MULTI-TENANCY

Implement/fix:

User

Organization

Membership

Roles

UUIDs

Real signup

Sessions

Email verification architecture

Password reset architecture

Organization creation

Invitation system

Plan-based member limits

Tenant isolation

## PHASE 2 — ORGANIZATION BILLING

Move subscription/credit/API-key ownership to Organization.

Implement:

Stripe customer

Subscription

Credit account

Ledger

Plan entitlements

## PHASE 3 — API KEYS

Organization-scoped API keys.

Secure hashing.

Creation/revocation.

Audit.

## PHASE 4 — REAL MODEL REGISTRY

Provider

AiModel

ModelEntitlement

ModelPricing

HostingMode

Licensing metadata

No fake live models.

## PHASE 5 — GATEWAY

FastAPI control plane.

OpenAI-compatible API.

Provider adapters.

Rate limiting.

Usage metering.

Credit checks.

## PHASE 6 — SHARED TASKFLOW HOSTING

Design the inference/compute abstraction.

Do not create an expensive permanent fleet.

Implement test/dev deployment capabilities only where economically safe.

## PHASE 7 — AWS COMPUTE PROVIDER

Implement AWS compute abstraction.

At first:

* infrastructure interfaces
* IAM assumptions
* dry-run mode
* cost safeguards
* no uncontrolled provisioning

Then carefully test a small GPU deployment when appropriate.

## PHASE 8 — DEDICATED GPU RENTAL

Implement:

GPU catalog

rental

billing

lifecycle

deployment

auto-stop

usage

cost tracking

## PHASE 9 — COMMUNITY GPU WORKERS

Implement:

worker registration

hardware detection

benchmark

heartbeat

availability

job scheduling

secure worker runtime

worker payouts

marketplace

## PHASE 10 — SCALE / PRODUCTION

Add:

PostgreSQL

Redis where justified

job queue

more providers

more GPU regions

monitoring

backups

disaster recovery

abuse detection

enterprise plans

---

# 63. WHAT NOT TO DO RIGHT NOW

Do NOT:

* build a huge GPU fleet
* buy hardware
* make fake model endpoints
* assume AWS credits are unlimited
* make Free unlimited
* give Max unlimited GPU compute
* expose arbitrary shell access through community GPUs
* hardcode pricing
* hardcode provider credentials
* let users choose their own prices in the frontend without server validation
* skip tenant isolation
* make users the billing entity
* mix GPU provider logic into model provider logic
* build Kubernetes just because it sounds scalable
* implement unnecessary microservices before demand exists

---

# 64. IMPORTANT ECONOMIC PRINCIPLE

TaskFlow must calculate unit economics.

For any model/GPU/workload:

## CUSTOMER REVENUE

## MODEL/PROVIDER COST

## GPU COST

## INFRASTRUCTURE COST

# PAYMENT FEES

GROSS CONTRIBUTION

The system should eventually let operators determine whether specific models, customers and GPU workers are profitable.

---

# 65. DEVELOPMENT PRINCIPLES

When modifying the code:

1. Inspect first.
2. Understand existing implementation.
3. Preserve useful working code.
4. Avoid unnecessary rewrites.
5. Use typed interfaces.
6. Add tests to critical business logic.
7. Keep configuration externalized.
8. Keep security server-side.
9. Validate tenant ownership.
10. Verify changes before moving on.

Do not blindly trust the existing README.

Inspect the actual code.

---

# 66. REQUIRED CURRENT ACTION

The immediate task is NOT to build GPUs.

The immediate task is to inspect and refactor the existing TaskFlow project so that it can support this architecture correctly.

Start by auditing:

* current repository
* Prisma schema
* authentication
* user model
* API keys
* subscriptions
* credits
* usage
* provider registry
* model registry
* current placeholder models
* Stripe
* GPU schema

Then produce an architecture report.

The report must include:

1. Current implementation
2. Problems
3. Security issues
4. Missing entities
5. Required schema changes
6. Required API changes
7. Required frontend changes
8. AWS integration plan
9. Model sourcing plan
10. GPU marketplace plan
11. Migration strategy
12. Implementation order

DO NOT start implementing the GPU marketplace yet.

DO NOT provision AWS GPUs yet.

DO NOT introduce fake models.

DO NOT delete working functionality simply because the architecture is changing.

---

# 67. FINAL PRODUCT MODEL

The final product should conceptually work like this:

CUSTOMER

↓

TaskFlow account

↓

Organization/workspace

↓

Subscription

↓

Monthly credits

↓

API key

↓

OpenAI-compatible TaskFlow API

↓

TaskFlow authenticates organization

↓

Check entitlement

↓

Check rate limits

↓

Check credits

↓

Select model

↓

Select inference source

↓

EXTERNAL API
OR
TASKFLOW-HOSTED GPU
OR
COMMUNITY GPU
OR
CUSTOMER DEDICATED GPU

↓

Run inference

↓

Measure tokens/compute

↓

Calculate cost

↓

Deduct credits / bill usage

↓

Return response

↓

Record usage

Meanwhile:

GPU OWNER

↓

TaskFlow Worker

↓

Hardware verification

↓

GPU joins marketplace

↓

TaskFlow schedules approved inference workloads

↓

GPU owner earns provider share

↓

TaskFlow retains marketplace/platform share

This is the long-term TaskFlow platform.

The short-term objective is to build the foundations correctly so that this future architecture can be added without rewriting the entire system.

Use this specification as the architectural source of truth unless a deliberate, documented engineering decision changes it.
