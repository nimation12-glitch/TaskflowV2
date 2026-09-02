# TaskFlow

**AI cloud & AI infrastructure marketplace.** One OpenAI-compatible gateway for AI models with
credit-based billing, token-level metering, API keys, plan entitlements and rate limits — evolving
into a marketplace and control plane connecting customers, AI models and distributed GPU
infrastructure.

> Master reference: `MASTER_PROJECT_CONTEXT.md` (Sections 1–67) is the product source of truth.
> Phase 0 architecture audit: `docs/ARCHITECTURE_REPORT.md` — current implementation, problems,
> security findings, required schema/API/frontend changes, AWS/model-sourcing/GPU-marketplace
> plans, migration strategy and implementation order.
> This README documents the implementation delivered so far (core ten + Phase 0 corrections).

---

## What is live now (Phase 1–7 core)

| Area | Status | Where |
|---|---|---|
| Landing site (honest claims only) | ✅ | `#/` → `src/components/taskflow/landing.tsx` |
| Auth (email + password, DB sessions) | ✅ | `src/app/api/auth/*`, `src/server/auth/*` |
| API keys (`tf_live_…`, shown once, hashed) | ✅ | `src/app/api/keys/*`, `src/server/auth/api-keys.ts` |
| AI gateway (OpenAI-compatible) | ✅ | `POST /api/v1/chat/completions`, `GET /api/v1/models` |
| Usage metering (tokens, latency, cost) | ✅ | `src/server/usage/recorder.ts`, `GET /api/usage` |
| Credit ledger (append-only, transactional) | ✅ | `src/server/billing/ledger.ts`, `GET /api/credits` |
| Pricing engine (DB rate cards + margin) | ✅ | `src/server/billing/pricing.ts` |
| Subscriptions Free/Pro/Max + REAL Stripe billing (org-anchored) | ✅ | `src/server/stripe.ts`, `src/server/billing/*`, `src/app/api/billing/*` |
| Dashboard (overview/keys/usage/billing/compute/models/docs) | ✅ | SPA at `/` |
| GPU catalog preview (rental = Phase 8) | 🟡 preview | `/api/compute/gpus`, Compute page |

## Phase 0 — architecture correction (done)

The spec (§62–66) now targets a two-sided marketplace (shared AI platform + GPU infrastructure
marketplace) with **Organizations as the billing entity**. Phase 0 audited the codebase and landed
the honesty/security corrections that must precede that refactor:

1. **Model registry honesty (§4–7, §50):** `AiModel` now carries `status`
   (LIVE / COMING_SOON / DISABLED / NOT_CONFIGURED / DEMO_ONLY), `hostingMode`
   (EXTERNAL_API / TASKFLOW_HOSTED / CUSTOMER_HOSTED), version, license and source metadata.
   Effective status = declared status ∧ provider configured on this deployment. The gateway
   refuses non-LIVE models; `/v1/models` only advertises callable models; the Models page shows
   the spec'd badges (LIVE / NOT CONFIGURED / COMING SOON / REQUIRES PRO|MAX).
2. **Stripe webhook hardening (S-1, critical):** unverified events are never applied. Simulated
   mode requires an authenticated session and forces events to target the session's own account;
   live mode without `STRIPE_WEBHOOK_SECRET` refuses (503).
3. **Pricing integrity (§43/§64):** a model without a `ModelPricing` rate card is refused
   (`pricing_not_configured`) instead of silently served for free.

Next up (spec Phase 1): Organizations, Memberships, invitations, org-scoped authorization and the
`/dashboard/team` page — the structural pivot the rest of the marketplace depends on.

## Request flow (gateway)

```
Customer app
  → POST /api/v1/chat/completions   (Authorization: Bearer tf_live_…)
  → authenticate key (peppered SHA-256 lookup)
  → identify customer + subscription (lazy monthly rollover happens here)
  → check entitlement (model ↔ plan, DB-backed)
  → rate limit (per-plan RPM, sliding window) + concurrency cap
  → check credit balance > 0
  → route via provider abstraction (registry)
  → upstream call (TaskFlow-managed compute or OpenAI-compatible provider)
  → price usage server-side (rate card × tokens × margin)
  → record UsageEvent + debit ledger atomically
  → respond OpenAI-shaped + taskflow metering block
```

**Billing safety (§15/§29):** requests that never reach a provider are never recorded or billed.
Upstream failures after dispatch are recorded as `FAILED` events with **zero charge**. Customers
never supply pricing or usage values; everything is computed server-side.

## Architectural decisions (and why)

1. **Next.js Route Handlers as the backend** (instead of the FastAPI sketch in the brief): the
   deployment runtime is a single-port Next.js environment. The service layer under
   `src/server/{auth,billing,usage,providers}` mirrors the intended FastAPI module layout, so
   extracting a Python control plane later is mechanical. The customer-facing API surface
   (`/api/v1/...`, OpenAI-compatible) is unchanged by this choice.
2. **SPA at `/` with hash navigation** (`#/dashboard/usage`, …): the preview environment surfaces
   only the `/` route. All dashboard sections are client-routed views; backend endpoints live under
   `/api/**` and are not user-visible pages.
3. **Money = integer micro-GBP** (`1_000_000 = £1.00`, field suffix `*Micros`): per-request AI
   charges are frequently < £0.01 (real measured example: **£0.000494**). Micro integers preserve
   them exactly through the append-only ledger without float money. Rates are float micros per 1K
   tokens; rounding happens once, at the transaction boundary.
4. **Append-only credit ledger**: balances are a transactional aggregate backed by
   `CreditTransaction` rows (`balanceAfterMicros` snapshots) — auditable and reconcilable (§17).
   Debits re-assert the balance guard inside the transaction.
5. **Lazy subscription rollover**: `ensureCurrentPeriod()` advances the period and grants the
   monthly allowance whenever a request arrives after `currentPeriodEnd` — no cron worker needed;
   a scheduler can call the same function later.
6. **In-memory rate limiting** (sliding window + concurrency per key): correct for one gateway
   process; the interface is a drop-in for Redis when scaling.
7. **Stripe dual mode**: with `STRIPE_SECRET_KEY` set, checkout uses real Stripe Checkout Sessions
   and all state changes happen via signature-verified, idempotent webhooks (`StripeEvent` table).
   Without keys, TaskFlow runs **simulated billing mode** — same state machine, clearly labelled in
   the UI — so the full subscription → credits → usage → invoice loop is demonstrable at zero cost.
8. **Entitlements are server-side only**: the Models page is display-only; the gateway re-checks
   every request against `ModelEntitlement` (§28). Frontend checks are never trusted (§29).

## Data model

`prisma/schema.prisma` (SQLite dev; swap provider for production):

users · sessions · plans · subscriptions · api_keys · models (AiModel) · model_entitlements ·
model_pricing · usage_events · credit_accounts · credit_transactions (append-only ledger,
uniqueGrantKey idempotency) · organizations (billing owner) · stripe_events (webhook idempotency) ·
invoices · gpu_types · gpu_instances · deployments
(last two reserved for Phase 9, no features wired).

```bash
bun run db:push        # apply schema
bun prisma/seed.ts     # plans, 6 models + entitlements + rate cards, GPU catalog
```

Seeded plans: **Free £0 (£2 credits, 20 rpm, priority 0)** · **Pro £30 (£15 credits, 100 rpm,
priority 5, GPU rental)** · **Max £90 (£50 credits, 300 rpm, priority 10, GPU rental)**.
Seeded credit packages: £10 / £25 / £50 / £100. All configurable in the DB — nothing hardcoded.

## Provider abstraction

`src/server/providers/`:

- `types.ts` — `ProviderAdapter` interface (`isConfigured()`, `chatCompletion()`) + typed
  `ProviderError` + token-estimation fallback for upstreams that omit usage.
- `taskflow-ai.ts` — TaskFlow-managed compute (platform AI service). No third-party keys needed;
  powers `taskflow-*` models out of the box (registry: `TASKFLOW_HOSTED`, status LIVE).
- `openai-compatible.ts` — one adapter covering OpenAI / OpenRouter / Moonshot / NVIDIA; a
  provider is only registered when its env key exists (`MOONSHOT_API_KEY`, etc.). Externally-hosted
  models like `kimi-k3` are labelled `EXTERNAL_API` with their true provider; on deployments
  without credentials they show **NOT CONFIGURED** and return an honest 503 if called.
- `registry.ts` — model router: catalog model → provider adapter; refuses non-LIVE models;
  introspection for health + effective-status computation.

Adding a provider = implement `ProviderAdapter` + register in the registry. Nothing else changes.

## Environment

Copy `.env.example` → `.env`. Key variables:

- `DATABASE_URL` — SQLite file (dev)
- `TASKFLOW_API_KEY_PEPPER` — **required in production** (openssl rand -hex 32)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_MAX`
- `MOONSHOT_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `NVIDIA_API_KEY` (optional)
- `API_BASE_URL` — public base URL for Stripe redirect URLs

Secrets are never exposed to the browser; only flag-style booleans and catalog data cross the wire.

## Stripe billing

TaskFlow runs **real Stripe billing only** — there is no simulated mode. Billing ownership:

```
User → Organization (billing owner) → Stripe Customer → Stripe Subscription
```

### Local development — Stripe TEST MODE

```bash
# 1. Put your sk_test_ key in .env (STRIPE_SECRET_KEY)
# 2. Create the products/prices + a webhook endpoint (writes price IDs to .env):
bun run stripe:setup --webhook-url https://YOUR-PUBLIC-HOST/api/webhooks/stripe
# 3. Restart the dev server. The UI shows a "Stripe Test Mode" badge.
# 4. Pay with the test card 4242 4242 4242 4242 (any future expiry, any CVC).
```

Money only moves through verified paths:
- **Webhooks** — `POST /api/webhooks/stripe` verifies the `stripe-signature` header against
  `STRIPE_WEBHOOK_SECRET`; missing/invalid signatures get 400, unverified events are never applied,
  and every event id is claimed in `StripeEvent` for exactly-once processing.
- **Verification-on-return** — after Checkout redirects back, the server re-reads the session from
  the Stripe API and applies the same idempotent fulfillment (works without a public webhook host).

Credits are granted ONLY on Stripe-confirmed payment:
- Credit packs → one ledger row per Checkout Session (`stripe_cs_…` key) with
  `stripe_payment_intent_id` / `stripe_checkout_session_id` / `stripe_event_id` metadata.
- Monthly allowances → one ledger row per subscription period (`stripe_sub_{id}_{period}` key);
  the lazy rollover consults the Stripe API before granting and never grants for
  PAST_DUE / PAYMENT_FAILED / CANCELED / INCOMPLETE subscriptions.

### Production — required configuration

TaskFlow **refuses to start** (instrumentation startup gate) unless all of these are set:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` — live payments (`sk_test_…` logs a loud TEST MODE warning) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` — webhook signature verification |
| `STRIPE_PRICE_PRO` | Pro £30/month recurring price |
| `STRIPE_PRICE_MAX` | Max £90/month recurring price |
| `STRIPE_PRICE_CREDIT_10/25/50/100` | one-time credit pack prices |
| `API_BASE_URL` | public base URL for Checkout redirects |

Never collect card details in the TaskFlow frontend — payment always happens on Stripe-hosted pages.

## Local development

```bash
bun run dev          # dev server (port 3000) — managed by the platform in this environment
bun run lint         # ESLint (clean)
bun run typecheck    # tsc --noEmit (clean for all TaskFlow code)
bun test tests/      # billing + webhook security suite (27 tests)
bash scripts/e2e-api-test.sh   # 18-step API smoke test (register → gateway → Stripe checkout → webhooks)
```

### Try the gateway

```bash
# 1. Sign up in the dashboard, create a key, then:
curl http://localhost:3000/api/v1/chat/completions \
  -H "Authorization: Bearer tf_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"taskflow-mini","messages":[{"role":"user","content":"Hello TaskFlow!"}]}'
```

Response includes a `taskflow` block: `charge_micros`, `balance_micros`, provider, latency.

## Cost-consciousness (§3/§36)

- No GPU infrastructure is provisioned in this phase; `gpu_instances`/`deployments` are schema
  placeholders. Compute page is an honest preview.
- Gateway refuses work at zero credit balance; concurrency + RPM caps bound upstream spend per key.
- API key creation is capped (25 active) to bound abuse surface.
- Development uses Stripe TEST MODE (`sk_test_…`): real Stripe, test data, ~£0 cost.

## Next phases (per §62 of the spec)

- **Phase 1: identity & multi-tenancy** — Organization/Membership/Invitation, org-scoped
  authorization on every route, AuditLog, `/dashboard/team`, auth hardening (rate-limited auth
  endpoints, session rotation, email-verification + password-reset architecture). The migration
  strategy (expand → backfill → dual-read → contract) is laid out in the architecture report §11.
- Org billing foundation landed (Organization as Stripe customer/subscription owner, grant idempotency,
  INCOMPLETE status, PAST_DUE grace). Remaining Phase 2: multi-member orgs, proration, dunning emails.
- Phases 3–5: org-scoped keys w/ enforced scopes, full model registry + admin surface, gateway
  hardening (streaming, rate-limit headers, SQL aggregation).
- Phases 6–9: `DryRunComputeProvider` first — then AWS compute behind cost safeguards, dedicated
  rental, community workers + marketplace. No GPU provisioning before its phase and explicit
  economic approval (§3, §24, §63).
