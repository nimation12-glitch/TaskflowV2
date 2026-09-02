# TaskFlow — Architecture Report (Phase 0: Architecture Correction)

**Spec source of truth:** `MASTER_PROJECT_CONTEXT.md` (§1–67) — the AI-cloud + GPU-marketplace edition.
**Scope of this report:** audit of the existing codebase (schema, auth, keys, subscriptions, credits, usage, provider registry, model registry, placeholder models, Stripe, GPU schema) and the plan to refactor it so it can carry the full marketplace architecture.
**Date:** 2026-09-01 · **Auditor:** lead engineer · **Codebase state at audit:** Phases 1–7 condensed delivered, 16-step E2E green, lint clean.

> Per §66: this report does NOT implement the GPU marketplace, does NOT provision AWS GPUs,
> does NOT introduce fake models, and does NOT delete working functionality.

---

## 1. Current Implementation

### 1.1 Stack & shape

| Layer | Reality |
|---|---|
| Runtime | Next.js 16 (App Router, single-port sandbox), TypeScript, Bun |
| Backend | Route Handlers under `src/app/api/**` + service layer `src/server/{auth,billing,usage,providers}` (mirrors the intended FastAPI module layout for later extraction) |
| Data | Prisma 6 + SQLite (`db/custom.db`), 16 models |
| Frontend | SPA at `/` with hash routing (`#/dashboard/…`), shadcn/ui, Recharts, Lucide |
| Payments | Stripe SDK when keyed; otherwise explicit **simulated billing mode** (same state machine) |
| Auth | Email+password (scrypt), DB-backed opaque sessions in httpOnly cookies |
| Keys | `tf_live_…`, 32 base62 chars, peppered SHA-256, raw shown once, 25-active cap |

### 1.2 What exists and works (verified by `scripts/e2e-api-test.sh`, 16 steps green)

- **Gateway pipeline** (`src/server/gateway.ts`): key auth → subscription entitlement → plan-based model entitlement (DB) → sliding-window rate limit (per-plan RPM) → concurrency cap → balance gate → provider routing → upstream call → server-side pricing → usage event + transactional ledger debit → OpenAI-shaped response with `taskflow` metering block.
- **Provider abstraction** (`src/server/providers/`): `ProviderAdapter` interface; `taskflow` (platform-managed inference via z-ai SDK) always registered; OpenAI-compatible adapter registered per provider only when its env key exists (moonshot / openrouter / openai / nvidia). Unconfigured providers return honest 503.
- **Pricing engine** (`src/server/billing/pricing.ts`): DB rate cards (`ModelPricing`), `(input + output + compute) × (1 + margin%)`, single rounding boundary, integer micro-GBP.
- **Credit ledger** (`src/server/billing/ledger.ts`): append-only `CreditTransaction` with `balanceAfterMicros` snapshots; guarded transactional debits; types `MONTHLY_GRANT | USAGE | PURCHASE | REFUND | ADJUSTMENT | GPU_RENTAL`.
- **Billing safety (§43)**: pre-dispatch failures record nothing; post-dispatch `ProviderError` records a zero-charge `FAILED` event; customers never supply pricing/usage.
- **Stripe** (`src/server/stripe.ts`): checkout sessions (payment + subscription modes), webhook application for `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated/deleted`, idempotency via `StripeEvent` unique-id claim.
- **Usage analytics** (`GET /api/usage`): totals, per-day buckets, per-model/provider maps, recent events.
- **Frontend**: landing, auth, dashboard shell, 7 views (overview / api-keys / usage / billing / compute preview / models / docs). Compute page is an honestly-labelled Phase-9 preview; billing page labels simulated mode.
- **GPU placeholders**: `GpuType`, `GpuInstance`, `Deployment` tables exist; **no GPU features are wired** (no provisioning path).

### 1.3 Config surface

Env consumed: `DATABASE_URL`, `TASKFLOW_API_KEY_PEPPER` (⚠ dev fallback), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO/MAX`, `API_BASE_URL`, `MOONSHOT_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `NVIDIA_API_KEY`. `.env.example` documents them.

---

## 2. Problems (architecture deviations from §1–67)

**P-1. Billing entity is the User, not an Organization (§13–15, §41, §63).**
Every owned row (`Subscription`, `CreditAccount`, `ApiKey`, `UsageEvent`, `Invoice`, `GpuInstance`, `Deployment`) is keyed on `userId`. The spec is unambiguous: *a user is not the billing entity*; the Organization is the primary tenant that owns subscription, credits, ledger, keys, usage, deployments, GPU instances and the Stripe customer. Grep confirms **zero** occurrences of organization/workspace/team/member anywhere in `src/`. This is the single largest structural gap.

**P-2. Model registry lacks identity/honesty metadata (§4–7).**
`AiModel` has no `status` (LIVE/COMING_SOON/DISABLED/NOT_CONFIGURED/DEMO_ONLY), no `hostingMode` (EXTERNAL_API/TASKFLOW_HOSTED/CUSTOMER_HOSTED), no version/license/source metadata. §6 requires placeholder models to be explicitly marked and the frontend to show that state; §5 requires license metadata before commercial hosting claims. Today `kimi-k3`/`llama-3.3-70b` render as ordinary catalog entries and only fail at call time with a 503.

**P-3. Model/provider vs compute-provider are not separated (§20–22).**
There is one provider concept (model inference). No `ComputeProvider` abstraction exists (provision/start/stop/terminate/status/health), which Phases 6–9 of the spec require before any GPU work.

**P-4. GPU schema is a stub, user-scoped, and not marketplace-ready (§27–35, §38, §40).**
`GpuInstance.userId` should be `organizationId` when rented; `Deployment` lacks `organizationId`, `modelId`, `provider`, `endpoint`, runtime/version fields per §38. Missing entirely: `Provider`, `ComputeProvider`, `GpuWorker`, `WorkerHeartbeat`, `GpuMarketplaceOffer`, `GpuRental`, `PayoutLedger`, `AuditLog`.

**P-5. Subscription lifecycle is lazy-only and incomplete (§45).**
Renewals happen only when a request touches `ensureCurrentPeriod` (key auth, login, `/me`). Inactive subscribers' periods stall indefinitely. `PAST_DUE_GRACE_DAYS = 7` is declared but never enforced. Subscription `status` lacks `INCOMPLETE`. No scheduler exists to advance periods or enforce grace.

**P-6. Plan switches re-grant full monthly credits with no proration (§8).**
`assignPlan` upserts + grants the full allowance every time. In simulated mode this is an infinite-credits loop (acknowledged demo behaviour, but the logic itself must become prorated/period-aware before real money).

**P-7. Frontend duplicates DB-configurable values (§8, §63 "do not hardcode pricing").**
Landing page hardcodes plan prices/credits/RPM (£0/£2/20, £30/£15/100, £90/£50/300) and auth view hardcodes "£2 monthly credits", duplicating `prisma/seed.ts`. Drift risk against the DB-driven billing surfaces.

**P-8. Streaming is absent (§20 `stream_chat_completion`).** Gateway rejects `stream: true` honestly. Required before launch-quality gateway.

**P-9. No admin/operator surface (§61), no AuditLog (§40), no cost safeguards (§54).**
`User.role` exists but is unreferenced; there are no admin routes. §54's configurable kill-switches (max runtime/spend/concurrency/deployments/rental duration) have no implementation home yet.

**P-10. UsageEvent lacks spec fields (§42).**
No `organizationId`, no `deploymentId`, no `infrastructureCostMicros` (has `computeCostMicros`), no separate `providerId` reference (free-text `provider` string only). Sufficient for tokens today, not for marketplace economics (§64).

**P-11. In-memory rate limiting and single-process assumptions (§10 scale).**
Correct for one instance; must be interface-swappable to Redis before multi-instance (already designed for, documented).

**P-12. Usage aggregation loads the whole window into JS** (`/api/usage` per-day buckets) — unbounded scan; must become SQL group-by before scale.

---

## 3. Security Issues (ranked)

### S-1 · CRITICAL — Stripe webhook applies unverified events outside full config
`src/app/api/webhooks/stripe/route.ts` verifies signatures only when **both** `STRIPE_SECRET_KEY` **and** `STRIPE_WEBHOOK_SECRET` are set. Otherwise (i.e. the entire simulated mode, or live mode with a missing secret) it parses **unverified JSON** and applies it: any unauthenticated POST of `{id, type:"checkout.session.completed", data:{object:{metadata:{taskflowUserId, …}}}}` can grant arbitrary credits or activate any plan for any user (only constraint: unique event id per forgery). This is an unauthenticated money-printing endpoint in every deployment without full Stripe config.
**Decision (fixed in this Phase 0):** in simulated mode the webhook route requires an authenticated dashboard session (it is a dev/demo facility, not a public endpoint); in live mode missing `STRIPE_WEBHOOK_SECRET` → hard 503, never apply unverified events. §46 "production must not silently fall back to simulations".

### S-2 · HIGH — Pepper has a silent dev fallback and the real pepper is committed
`env.ts` falls back to `"taskflow-dev-pepper-NOT-FOR-PRODUCTION"` when `TASKFLOW_API_KEY_PEPPER` is missing — keys remain forgeable by anyone who knows the fallback; the only signal is a boolean on `/api/health`. Additionally the working `.env` carries a real pepper value checked into the project directory; rotating it invalidates all stored key hashes.
**Decision:** document as **pre-production gate** — startup must fail (or refuse live traffic) without a configured pepper in production (§46); rotate pepper as part of production cutover checklist. No dev change now (would break all existing dev keys for zero risk reduction).

### S-3 · HIGH — Monthly credit grant race (double-grant)
`ensureCurrentPeriod` is read-then-write with no transaction/unique guard around the rollover decision; two concurrent first-requests after period expiry can both grant `MONTHLY_GRANT`. `assignPlan` shares the pattern.
**Fix (Phase 1):** wrap decision+grant in a single transaction with a conditional update (`UPDATE … WHERE currentPeriodEnd = <readValue>`), or add a per-subscription rollover row with unique `(subscriptionId, periodStart)` so the grant insert enforces uniqueness. Scheduled for the org-billing refactor (P-1) since both touch the same tables.

### S-4 · MEDIUM — Settlement shortfall path
Pre-flight check is `balance > 0`; a request whose cost exceeds the balance settles as `"Charge deferred: insufficient credits at settlement"` with **no ledger write-off** and no compensation — reconciliation debt discovered only by audit. Bounded per request but real.
**Fix (Phase 2):** either (a) reject pre-flight unless `balance ≥ maxEstimatedCost` (estimable from rate card + `max_tokens`), or (b) record an explicit `ADJUSTMENT` write-off row so the ledger reconciles by construction. (a) preferred; (b) as fallback for races.

### S-5 · MEDIUM — Missing `ModelPricing` row ⇒ silently £0 charge
`priceUsage` returns all zeros when the rate card is absent. A misconfigured model becomes free infrastructure.
**Decision (fixed in this Phase 0):** missing rate card is a hard 500-class `pricing_not_configured` gateway error — refuse to serve rather than serve for free (§43/§64: never fabricate; unit economics must be computable).

### S-6 · MEDIUM — Auth lifecycle gaps (§16)
No email verification, no password reset, no session rotation on login, no "revoke all sessions", register/login unrate-limited (account spam + password spraying), no CSRF token (protection is SameSite=lax only), `permissions` on API keys parsed but never enforced. All are §16/§18 requirements or natural consequences; scheduled in Phase 1 (identity) — see §12 of this report.

### S-7 · LOW — Build hygiene
`next.config.ts` sets `typescript.ignoreBuildErrors: true` (type safety enforced only by editors); Prisma client logs every query in all environments (`lib/db.ts`); `next-auth` dependency installed but unused; `User.role` unreferenced. Low exploitability today, but they hide errors and secrets-adjacent noise in production.

### S-8 · LOW — Public endpoints leak mild config
`/api/health` exposes `billingMode`, `keyPepperConfigured`, provider list; `/api/compute/gpus` exposes the catalog. Acceptable by design (status page semantics), keep payloads minimal.

**What the audit confirmed as sound:** all session routes derive identity from the cookie and re-scope every read/write by owner (no client-supplied userId is trusted anywhere; `[id]` routes 404 on foreign ids); raw API keys are never stored/logged and are destroyed (hash overwritten) on revoke; ledger math is integer micro-GBP with in-transaction balance guards; webhook idempotency via unique event-id claim is correct in design; no pricing/usage value is ever accepted from the client (§42/§63).

---

## 4. Missing Entities (vs §40)

Present today: `User`, `Session`, `Plan`, `Subscription`, `ApiKey`, `AiModel`, `ModelEntitlement`, `ModelPricing`, `UsageEvent`, `CreditAccount`, `CreditTransaction`, `StripeCustomer`, `StripeEvent`, `Invoice`, `GpuType`, `GpuInstance`, `Deployment`.

Missing entirely (spec §40 names them; none are implemented now — this is correct phased behaviour, listed here so the schema plan anticipates them):

| Entity | Purpose (spec ref) | Needed by phase |
|---|---|---|
| `Organization` | primary tenant & billing entity (§13) | **now (Phase 1)** |
| `Membership` | user↔org with role OWNER/ADMIN/MEMBER (§14) | **now (Phase 1)** |
| `Invitation` | team invites with plan-based member limits (§14, §49) | Phase 1 |
| `Provider` | model-provider registry rows (§7, §40) | Phase 4 (registry) |
| `ComputeProvider` | GPU hardware supplier registry (§21–22, §40) | Phase 6–7 |
| `GpuWorker` | community worker identity/status (§30–33) | Phase 9 |
| `WorkerHeartbeat` | worker liveness/capacity (§31) | Phase 9 |
| `GpuMarketplaceOffer` | owner-listed GPU capacity w/ price & reliability (§34) | Phase 9 |
| `GpuRental` | dedicated rental contract & billing window (§28–29) | Phase 8 |
| `PayoutLedger` | provider share vs TaskFlow share attribution (§35) | Phase 9 |
| `AuditLog` | privileged-action audit (§40, §61) | Phase 1 (cheap to add early) |

Field-level gaps in existing entities: see §5.

---

## 5. Required Schema Changes

Ordered to be individually shippable; each step keeps SQLite/Prisma and is push-migratable in dev.

### Step A — Organizations & tenancy (Phase 1–2 of spec plan; the structural pivot)

```
Organization   id(uuid) name slug(uniq) stripeCustomerId createdAt
Membership     id organizationId userId role(OWNER|ADMIN|MEMBER) createdAt
               @@unique([organizationId, userId])
OrganizationInvitation id organizationId email role token(uniq) status expiresAt invitedBy createdAt
```

Ownership migration (§41 — `organization_id` where appropriate, keep `userId` for attribution):

| Table | Change |
|---|---|
| `Subscription` | +`organizationId` (unique per org); keep `userId` = acting owner |
| `CreditAccount` | +`organizationId` (unique); ledger rows follow account |
| `CreditTransaction` | +`organizationId` (denormalized for audit queries) |
| `ApiKey` | +`organizationId`; `createdByUserId` replaces primary `userId` |
| `UsageEvent` | +`organizationId`, +`deploymentId?`, +`infrastructureCostMicros` |
| `Invoice` | +`organizationId` |
| `GpuInstance` | +`organizationId` (when rented) |
| `Deployment` | +`organizationId`, +`modelId?`, `provider`, `endpoint`, `runtime`, `version`, richer status enum per §38 |

`Plan` gains `maxMembers Int @default(1)` (§14: Free = 3 total, configurable — never hardcode "2").

### Step B — Model registry honesty (Phase 0, done now)

```
AiModel +status        String @default("COMING_SOON")  // LIVE | COMING_SOON | DISABLED | NOT_CONFIGURED | DEMO_ONLY
        +hostingMode   String @default("EXTERNAL_API") // EXTERNAL_API | TASKFLOW_HOSTED | CUSTOMER_HOSTED
        +version       String?
        +license       String?
        +sourceUrl     String?
```
Seeding marks `taskflow-*` = `LIVE`/`TASKFLOW_HOSTED` (they genuinely serve via the platform-managed inference backend — nothing is faked), `kimi-k3` = `EXTERNAL_API` with license metadata and effective status computed against configured providers at read time.

### Step C — Subscription state machine (Phase 2)

`status` adds `INCOMPLETE`; `Organization.stripeCustomerId` becomes the Stripe anchor; add unique `(subscriptionId, periodStart)` on a rollover/grant helper table **or** conditional-update pattern to kill the double-grant race (S-3).

### Step D — Marketplace-ready GPU (Phases 7–9; schema only when each phase lands)

`ComputeProvider`, `GpuWorker`, `WorkerHeartbeat`, `GpuMarketplaceOffer`, `GpuRental`, `PayoutLedger`, `AuditLog` per §40/§27/§31/§33/§35. `GpuInstance` gains `computeProviderId`, `providerInstanceId`, `maxRuntimeMinutes`, `maxDailySpendMicros` (§54 safeguards). **Do not create these tables before their phase** — they are listed to freeze the target shape.

---

## 6. Required API Changes

1. **Org context resolution** — every session route resolves `(user, organization, membership, role)` from the active-org cookie/header (§17). Default org auto-created at signup. Server-side authorization on every org-owned resource; frontend filtering is never trusted.
2. **Team endpoints (§49)** — `GET/POST /api/team/members`, `PATCH /api/team/members/:id` (role), `POST /api/team/invitations`, `DELETE /api/team/invitations/:id`, all enforcing plan-based member limits server-side.
3. **Org CRUD** — create/list orgs, switch active org, rename; OWNER transfer (Phase 1+).
4. **Models surface (§50)** — `/api/models` and `/api/v1/models` include `status`, `hostingMode`, effective availability (computed against configured adapters), license summary. `/v1/models` lists entitlement ∩ status=LIVE by default with an `include_unavailable` flag for dashboards.
5. **Gateway guard** — refuse models whose effective status ≠ LIVE (defense-in-depth; today the 503-from-registry already yields the honest outcome for unconfigured externals).
6. **Billing endpoints become org-scoped** (checkout, subscription, invoices) with the Stripe customer on the org; webhook application targets orgs by `metadata.taskflowOrganizationId`.
7. **Streaming** — `POST /api/v1/chat/completions` with `stream:true` via SSE, metered on final chunk (Phase 5-hardening; explicitly deferred, honest 400 today).
8. **Admin surface (§61)** — `/api/admin/*` guarded by `role === "ADMIN"` **plus** org-independent authorization: model enable/disable, pricing edits, credit adjustments (ledger `ADJUSTMENT`), worker suspension, infra kill-switch. Ship the guard + model/pricing endpoints first; expand later.
9. **Rate-limit headers** — `X-RateLimit-Limit/Remaining/Reset` on gateway responses (observability §60; currently only 429 carries Retry-After).

---

## 7. Required Frontend Changes

1. **Org/workspace in the shell (§47–48)** — org name + UUID in dashboard header and overview; active-org switcher when >1 org; "Invite member" quick action.
2. **New `/dashboard/team` view (§49)** — members, roles, pending invitations, member limit ("Free: max 3 total"), invite/revoke controls; all limits mirrored from API, enforced server-side.
3. **Models page (§50)** — status badges exactly as spec'd: `LIVE`, `COMING SOON`, `NOT CONFIGURED`, `REQUIRES PRO/MAX`; hosting-mode + license line; cost hint. No frontend-only access decisions (display only).
4. **Billing page (§52)** — identity becomes the organization; add GPU charges section (populated in Phase 8) and payment status.
5. **Overview (§48)** — add GPU usage, deployments, team count tiles + quick actions (Rent GPU / Deploy model appear but route to honest "coming soon" until their phases).
6. **De-hardcode pricing (P-7)** — landing/auth copy pulls plans & prices from `/api/billing/checkout` (GET) or a public `/api/plans`; the DB remains the single source.
7. **Docs page** — add team/org section once shipped; keep the "failed requests are never billed" honesty copy.

---

## 8. AWS Integration Plan (§23–26, §55 — **no provisioning now**)

1. **Abstraction first (Phase 6–7):** `ComputeProvider` interface (`provision/start/stop/restart/terminate/status/healthCheck/attachStorage/deployModel`) in `src/server/compute/`; business logic calls the interface, never AWS SDKs directly. First implementation: **`DryRunComputeProvider`** — full state machine (REQUESTED→PROVISIONING→…→TERMINATED) with no real infrastructure, exercising rental/billing/lifecycle code end-to-end at zero cost (§7 Phase 7 "dry-run mode").
2. **AWS adapter second**, config-driven: instance family selectable (G6/L4, G6e/L40S, G5/A10G; P-series only with written economics), region configurable, IAM role-based (no long-lived keys in app), separate compute credentials from app credentials (§55).
3. **Cost safeguards before first real instance (§54):** max runtime, max daily spend per instance and per org, idle timeout auto-stop (configurable, default conservative), max concurrent provisions, global kill-switch env. Every provision request must pass a pre-flight economics check (§24): hourly cost × expected utilization vs customer price and margin.
4. **First real test (only when approved):** smallest viable instance (e.g. single L4-class) serving one small open-weight model, bounded by max daily spend ≤ what £10 of credits covers; tear down automatically on idle. Total exposure capped in config.
5. **Storage/runtime (§56–57):** S3 model artifact store with versioned objects + checksums; runtime chosen per model (containerized inference servers), runtime compatibility recorded in model metadata.

---

## 9. Model Sourcing Plan (§4–7)

1. **Near-term revenue with zero capex: EXTERNAL_API.** Keep routing through configured providers (moonshot/openrouter/openai/nvidia). Every externally-hosted model is labelled `EXTERNAL_API` with the true provider — TaskFlow never claims ownership of third-party inference (§4).
2. **Registry honesty (done in Phase 0, maintained onward):** every catalog row carries `status`, `hostingMode`, `version`, `license`, `sourceUrl`. Models whose licensing/terms haven't been reviewed are not advertised for commercial hosting; unavailable ones show `NOT_CONFIGURED`/`COMING_SOON` rather than silently failing.
3. **License review gate:** before any model becomes `LIVE` as TaskFlow-hosted, record license type, commercial-use status, redistribution restrictions and artifact location in the registry (§5). No license review → no commercial hosting claim.
4. **TASKFLOW_HOSTED later (Phase 6+):** only after the ComputeProvider dry-run proves the lifecycle and the first small AWS instance passes the economics check. Platform-managed inference (the current `taskflow-*` backend) remains labelled honestly as TaskFlow-managed.
5. **CUSTOMER_HOSTED (Phase 8):** customers may deploy models they legally control onto rented GPUs; TaskFlow never implies it grants rights the customer lacks (§39) — a deploy-time attestation checkbox + license field on the deployment record.

---

## 10. GPU Marketplace Plan (§30–35 — **design only; implementation is Phases 8–9**)

1. **Order of construction:** dedicated rental (single-tenant, TaskFlow-operated compute) → marketplace listing (offers from workers) → community workers → payouts. Each layer reuses the same `GpuInstance`/`Deployment` lifecycle, so rental work is never throwaway.
2. **Worker architecture (§31):** outbound-only connections (worker polls/long-polls TaskFlow; no inbound ports), authenticated worker tokens, heartbeat + capacity reporting, signed job definitions. Workers are **untrusted infrastructure** (§32): approved inference workloads only, containerized, resource-limited, filesystem/network isolated, no arbitrary code, no shell.
3. **Worker lifecycle (§33):** PENDING→VERIFYING→ACTIVE (with hardware detect, CUDA/runtime check, benchmark, VRAM/CPU/RAM report, reliability score) → DEGRADED/SUSPENDED/OFFLINE/REVOKED.
4. **Economics (§35):** every rental/job records customer charge, provider share, TaskFlow share, runtime, marketplace transaction. Split is DB-configurable (never hardcoded); payouts computed server-side into `PayoutLedger`. Unit-economics views (§64) eventually let operators see per-model/per-worker/per-customer profitability.
5. **Marketplace display (§34):** GPU type, VRAM, region, price/hour, availability, reliability, provider type, performance class — prices always presented as configurable/dynamic, never "final".

---

## 11. Migration Strategy (user-scoped → org-scoped, without breaking what works)

Principle: **expand–contract, no big-bang rewrite, no deletion of working functionality** (§66).

1. **Expand (additive, non-breaking):** create `Organization`, `Membership`, `OrganizationInvitation`; add nullable `organizationId` columns to owned tables; add `Plan.maxMembers`; add model registry fields (Step B).
2. **Backfill:** signup flow creates a personal org per user (OWNER membership); one org per existing user backfilled; `organizationId` populated from each row's `userId` via the membership.
3. **Dual-read window:** services read org context when present, fall back to user context; API responses gain `organization` fields while keeping `user` fields. Frontend migrates view-by-view.
4. **Contract (flip default):** after all routes resolve org context, make `organizationId` required on new writes; unique constraints move from `userId` to `organizationId` (subscription/credit account per org); old `userId`-unique indexes dropped.
5. **Keys & gateway:** `ApiKey.organizationId` added; `authenticateApiKey` returns org context; gateway pipeline swaps `key.user.subscription` → `key.organization.subscription` behind one seam; entitlement/ledger/rate-limit calls change signature, not order.
6. **Stripe:** new checkouts attach customer to org (`metadata.taskflowOrganizationId`); webhook application becomes org-targeted; legacy per-user rows keep working until each org's next billing event.
7. **Verification at every step:** the 16-step E2E script extended per step (org assertions added in step 2, team tests added at Phase 1 sign-off); lint + typecheck gates; no step merges red.

Rollback safety: every step is additive until the "contract" flips, which happens only after org-context coverage is 100% in server tests/E2E.

---

## 12. Implementation Order

Mapping the spec's phased plan (§62) onto the audited codebase. "Now" items are this Phase 0 commit.

| # | Work | Spec phase | Status |
|---|---|---|---|
| 0a | This audit + report; document actual architecture | 0 | **done** |
| 0b | Model registry honesty fields + Models page status badges + gateway LIVE guard | 0 | **done now** |
| 0c | Webhook: never apply unverified events (session-required in simulated mode; hard-fail live mode without secret) | 0 / §46 | **done now** |
| 0d | Missing rate card ⇒ hard error, not free inference | 0 / §43 | **done now** |
| 1 | Organizations & Membership & invitations; org-scoped authz on every route; AuditLog; `/dashboard/team`; session/auth hardening (rate-limit auth endpoints, session rotation, email-verification & password-reset architecture) | 1 | next |
| 2 | Org billing: Stripe customer on org, ledger/account/subscription re-scope, rollover race fix (S-3), `INCOMPLETE` state, grace enforcement, proration on plan change, scheduler seam for period advancement | 2 | after 1 |
| 3 | Org-scoped keys + enforced `permissions` scopes + key audit records | 3 | after 2 |
| 4 | Full model registry: `Provider` rows, licensing metadata workflow, admin model/pricing endpoints | 4 | after 3 |
| 5 | Gateway hardening: streaming (SSE), rate-limit headers, SQL aggregation for usage, Redis-swappable limiter interface | 5 | after 4 |
| 6 | Shared-hosting design + `DryRunComputeProvider` lifecycle (no fleet) | 6 | after 5 |
| 7 | AWS `ComputeProvider` adapter behind dry-run; cost safeguards; IAM; then (only with explicit approval) one small GPU instance test with capped spend | 7 | after 6 |
| 8 | Dedicated GPU rental: catalog→rental→billing→lifecycle→auto-stop→usage/cost tracking | 8 | after 7 |
| 9 | Community workers + marketplace + payouts (`GpuWorker`, offers, signed jobs, PayoutLedger) | 9 | after 8 |
| 10 | Scale/production: Postgres, Redis, job queue, monitoring/backups/DR, abuse detection, enterprise plans | 10 | last |

**Explicitly not now (§63):** no GPU fleet, no hardware purchases, no fake model endpoints, no Kubernetes/microservices, no uncontrolled provisioning, no hardcoded pricing, no tenant-isolation shortcuts.

---

## Appendix — Phase 0 changes made in this commit

1. `MASTER_PROJECT_CONTEXT.md` — the §1–67 spec committed as source of truth (README references updated).
2. Model honesty: `AiModel` + `status`, `hostingMode`, `version`, `license`, `sourceUrl`; seed marks all catalog models truthfully; `/api/models`, `/api/v1/models` and the Models page expose status/hosting mode; gateway refuses non-LIVE models (`model_unavailable`).
3. Webhook hardening: simulated-mode events require an authenticated session; live mode without `STRIPE_WEBHOOK_SECRET` returns 503 and applies nothing (E2E step 16 updated to authenticate).
4. Pricing: missing `ModelPricing` row → `pricing_not_configured` (500) instead of silent £0 charge.
5. `docs/ARCHITECTURE_REPORT.md` — this document.
