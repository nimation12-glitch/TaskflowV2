# TaskFlow — Authentication Correction & Production Identity Hardening Report

Final report for the 22-item correction specification. Every claim below is backed by the current codebase, the 84-test automated suite, the 26-step E2E run, and live runtime verification.

---

## 1. Authentication framework

**Status: COMPLETE — Auth.js (NextAuth v5, `next-auth@5.0.0-beta.32`).** Arctic is fully removed from the authentication protocol layer.

- OAuth protocol (state / PKCE / nonce / code exchange / ID-token claims) is owned by Auth.js, mounted at `/api/auth/[...nextauth]`.
- A custom database adapter (`src/server/auth/authjs/adapter.ts`) maps Auth.js onto the EXISTING domain models — User, AuthenticationIdentity, Session — with no schema clobbering. OAuth provider tokens are never persisted.
- Credentials (email/password) run through an Auth.js Credentials provider whose `authorize()` holds the verification policy; the login route drives the framework's `Auth()` entry server-side and converts the result into a TaskFlow **database** session — no JWT cookies, one session mechanism.
- All prior domain architecture preserved: User → Membership → Organization, Stripe org-anchoring, API-key org-anchoring, tenant isolation, credit/usage architecture, billing architecture.

## 2. Email verification

**Status: COMPLETE.** Registration creates a **PENDING** (unverified) account → high-entropy challenge (AuthToken, SHA-256-hashed at rest, 24h expiry, single-use, rate-limited, resend-limited) → emailed link → `emailVerifiedAt` set. Provider-verified emails (OAuth) upgrade verification, never downgrade. Password reset and verification flows return uniform responses that never reveal whether an email exists (anti-enumeration, covered by tests).

## 3. Phone verification

**Status: COMPLETE.** Email/password signups additionally require SMS verification before activation: E.164-normalized number → 6-digit CSPRNG code → pluggable SmsProvider → `phoneVerifiedAt` set → activation. Challenge security: HMAC-hashed codes (raw codes never stored), 10-minute TTL, single-use, 5-attempt cap, per-user + per-IP rate limits, new challenges invalidate outstanding ones. Full numbers are masked in every log; codes appear ONLY in the dev outbox. The account remains PENDING until the verification policy is satisfied — the organization is never fully active before that (§17 pending-account state).

## 4. Google / Microsoft / GitHub OAuth

**Status: IMPLEMENTED; credentials pending owner console registration (cannot be invented).**

| Provider | Code | Config state on this deployment |
|---|---|---|
| Google | Auth.js Google provider, `openid email profile`, checks `pkce+state+nonce` | buttons disabled + truthful config hint (no fake flows) |
| Microsoft Entra ID | issuer pinned to `MICROSOFT_TENANT_ID`, identity-only scope (Graph `User.Read` removed) | same |
| GitHub | state+PKCE, primary-email resolution with verified flag | same |

Client IDs/secrets are read server-side only; `AUTH_URL` is pinned to `APP_BASE_URL` at startup so callbacks are exact trusted URLs, never Host-derived. **Callback URLs to register:**
- `https://preview-chat-970b43ea-568a-4d4b-b88d-383d3eae4f1d.space-z.ai/api/auth/callback/{google|microsoft-entra-id|github}` (development)
- `https://taskflow.web-agent.org/api/auth/callback/{google|microsoft-entra-id|github}` (production)

## 5. Session security

**Status: COMPLETE (unchanged posture, now through Auth.js).** Database sessions; 32-byte random tokens; only SHA-256 hashes stored; HttpOnly + SameSite=Lax + Secure-in-production cookies; 30-day expiry; revocation enforced on every check (logout, password reset revokes ALL sessions, explicit revoke); lastUsedAt + IP/UA tracking; token reuse after logout fails (tested). No tokens in localStorage.

## 6. Organization model

**Status: COMPLETE.** First activation provisions User → Organization → OWNER Membership → Free subscription → credit account **transactionally and idempotently** — repeated OAuth callbacks cannot duplicate the organization (proven by tests). Organization owns the Stripe customer, subscription, credits, ledger, API keys, usage, invoices, members.

## 7. Membership & roles

**Status: COMPLETE.** OWNER > ADMIN > MEMBER hierarchy enforced by a single centralized server-side authorization choke point (`server/tenancy/authz.ts`: `getOrgContext` / `requireOrgRole` / `requireOrgMember`). Billing is OWNER-only. The active-org cookie is re-validated against Membership on every request. Free-plan seat cap (owner + 2) is DB-backed and plan-configurable via `Plan.maxMembers` (pro=10, max=25).

## 8. Tenant isolation

**Status: COMPLETE.** Every org-owned resource (members, invitations, API keys, credits, usage, subscriptions, invoices, deployments) is queried with `organizationId` scoping; cross-org IDs are 403 (tested: tampering, role bypass, stranger access, revoked keys, MEMBER 403s on keys/checkout). Frontend checks are treated as UX only.

## 9. Email & SMS transports

**Status: COMPLETE.** EmailProvider: dev console+DB outbox ↔ Resend for production (fail-closed when unconfigured; the UI distinguishes "sent" from "not configured" — the app never claims delivery the provider did not accept). SmsProvider: interface with `send()`; environment-driven selection — `SMS_PROVIDER=dev` (this deployment) | `twilio` | unset-in-production = fail-closed explicit `sms_not_configured`. No provider credentials in client code; production outbox rows are code-free.

## 10. Stripe billing

**Status: NO REGRESSION.** The real Stripe architecture is intact (org-anchored checkout/fulfillment/webhooks, signature-required, idempotent via StripeEvent + uniqueGrantKey). Simulated-billing wording: none. Production fail-closed at startup on missing key/webhook secret/price IDs (27 billing tests green). This deployment runs Stripe **TEST MODE**; LIVE keys required in production.

## 11. Environment variables & secrets

**Status: COMPLETE.** All secrets server-side only; nothing `NEXT_PUBLIC_*`. `.env` (this deployment, gitignored) now contains every supplyable key: generated `AUTH_SECRET`, API-key pepper, Stripe TEST key + webhook secret + all 6 price IDs, `SMS_PROVIDER=dev`, and the multi-environment origin config. OAuth client IDs/secrets and `RESEND_API_KEY` are empty-with-instructions until their consoles are set up (never fabricated). `.env.example` documents every variable with no real values.

**Deployment environments (as requested):**
- Development: `http://localhost:3000` **and** `https://preview-chat-970b43ea-568a-4d4b-b88d-383d3eae4f1d.space-z.ai` (this deployment's `APP_BASE_URL`; `TRUSTED_ORIGINS` whitelists all three fronts for the same-origin CSRF gate)
- Production: `https://taskflow.web-agent.org`

## 12. Vercel deployment requirements

Set as **Vercel server-side environment variables** (Production): `APP_BASE_URL=https://taskflow.web-agent.org`, `AUTH_SECRET` (fresh, separate), `DATABASE_URL` (hosted managed Postgres — the local SQLite file is a dev convenience; switch the Prisma datasource provider before the production cutover), Stripe LIVE key + webhook secret + price IDs, OAuth credentials, `RESEND_API_KEY`, Twilio credentials, `TASKFLOW_API_KEY_PEPPER` (fresh). Startup refuses to boot in production without `AUTH_SECRET` and complete Stripe config (fail closed). Re-register the Stripe webhook endpoint to the production host.

## 13. CSRF / origin hardening (new)

**Status: COMPLETE.** A global Next.js 16 proxy gate (`src/proxy.ts` + edge-safe `src/server/origin.ts`) rejects cross-site mutating `/api` requests with a proper **403** before handlers run, accepting only: the request's own host, `APP_BASE_URL`, or an explicit `TRUSTED_ORIGINS` entry. This fixed a found defect where auth routes answered CSRF rejections with 500. In-handler `assertSameOrigin` remains as defence in depth. Verified live: evil origin → 403; preview/localhost/webhook-style → unaffected.

## 14. Verification results

| Check | Result |
|---|---|
| `bun test tests/` | **84/84 pass** (27 billing + 57 identity incl. 12 phone-verification), 347 assertions |
| `bun run lint` | clean, zero errors |
| `bun run typecheck` | TaskFlow code clean (4 pre-existing sandbox-scaffold errors in `skills//examples/` unchanged) |
| `bun run build` | succeeds — Proxy (Middleware) compiled into the build |
| E2E (26 steps) | **EXIT_CODE=0** — register→verify→phone→activate, invitation+seat limit 3/3, tenant isolation, MEMBER 403s, logout-reuse 401, unsigned/invalid webhook 400, OAuth honesty |
| Live preview URL | `/api/auth/me`, `/api/health`, real registration (201) all verified through `https://preview-chat-970b43ea-568a-4d4b-b88d-383d3eae4f1d.space-z.ai` |

All external providers (Google/Microsoft/GitHub/SMS/email) are mocked at the protocol boundary in automated tests; no fabricated provider successes. Real-provider validation requires the console registrations above.

## 15. Remaining blockers (operator actions, no code)

1. **OAuth**: create the three provider apps and register the callback URLs (§4), then fill `*_CLIENT_ID/SECRET` in `.env` (dev) / Vercel (prod) — buttons activate immediately.
2. **Production email**: set `RESEND_API_KEY` (Vercel).
3. **Production SMS**: `SMS_PROVIDER=twilio` + Twilio credentials (Vercel).
4. **Vercel production cutover**: hosted Postgres `DATABASE_URL` + Prisma provider switch; fresh `AUTH_SECRET` and API-key pepper.
5. **Stripe**: move to LIVE keys in production; re-register the webhook endpoint to the final production host (until then, verification-on-return still fulfills checkout sessions).
