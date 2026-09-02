# TaskFlow — Multi-Agent Worklog

Project: TaskFlow — AI API gateway & AI infrastructure platform (https://taskflow.web-agent.org)
Owner context: MASTER_PROJECT_CONTEXT.md (Section 1–41) — treat as source of truth.

---

Task ID: 1
Agent: main (Super Z)
Task: Build TaskFlow core foundation (Phase 1–7 condensed): frontend, backend, database, auth, API keys, model gateway, usage tracking, credit system, Stripe subscriptions, dashboard.

Work Log:
- Loaded fullstack-dev skill; initialized environment (Next.js 16, port 3000, SQLite via Prisma).
- Inspected scaffold: shadcn/ui full set, Recharts, z-ai-web-dev-sdk, Prisma 6 present.

Stage Summary:
- Architectural adaptations (strong technical reasons, documented for the team):
  1. Backend implemented as Next.js Route Handlers + service layer (`src/server/*`) instead of FastAPI: the sandbox runtime is a single-port Next.js environment (non-negotiable per platform). Service modules mirror the intended FastAPI layout (auth/billing/usage/providers/gateway) so a later FastAPI extraction is mechanical. Customer-facing API surface unchanged (`/api/v1/...`, OpenAI-compatible).
  2. Entire frontend is a SPA at `/` with hash-based navigation (`#/dashboard/usage` etc.): sandbox preview only surfaces the `/` route. Backend endpoints live under `/api/**` (not user-visible pages).
  3. Money stored as integer pence internally (1 credit = £1 = 100p); rates stored as float pence per 1K tokens; rounding at transaction boundary.
  4. In-memory sliding-window rate limiter (per API key, per-plan RPM) — adequate for single instance; swap for Redis later.
  5. Stripe: real SDK integration when `STRIPE_SECRET_KEY` configured; otherwise explicit "simulated billing mode" so the full subscription/credit flow is demonstrable without keys. Webhook handling idempotent via `StripeEvent` table.

---
Task ID: 1 (final)
Agent: main (Super Z)
Task: Complete TaskFlow core foundation build + verification

Work Log:
- Implemented full backend: 16 API route files (auth×4, keys×2, models, usage, credits, billing×3, v1 gateway×2, webhooks/stripe, compute/gpus, health).
- Implemented server layer: scrypt password hashing, DB-backed sessions (httpOnly cookies), tf_live_ API keys (peppered SHA-256, shown once, 25-key cap), provider abstraction (taskflow-managed via z-ai SDK + OpenAI-compatible adapter + registry router), pricing engine (DB rate cards + margin), append-only credit ledger (transactional, balance-guarded debits), usage recorder (no billing on failures), sliding-window rate limiter + concurrency caps, Stripe integration (live checkout/webhooks + simulated dev mode, idempotent via StripeEvent table), lazy subscription rollover with monthly credit grants.
- Implemented frontend SPA at /: landing (dark hero, features, pricing, FAQ), auth, dashboard shell (sidebar + mobile drawer), 7 views (overview w/ Recharts trend, api-keys w/ once-only raw key modal, usage w/ charts + event table, billing w/ plan switching + credit packs + invoices, compute w/ Phase-9 GPU catalog preview, models w/ tier gating, docs w/ copyable examples).
- Verified E2E via scripts/e2e-api-test.sh (16 steps, all passing) and Agent Browser (signup → key creation → simulated Pro upgrade → £10 credit purchase → real metered gateway call → usage charts → mobile responsive → sticky footer). Fixed during verification: /api/auth/me missing subscription lookup; stripe package install; 3 lint errors; docs balance £ formatting; dialog a11y description.

Stage Summary:
- DELIVERED: working TaskFlow foundation — all 10 items of Section 40.
- Real metered AI verified: taskflow-reasoning call cost £0.000494, balance debited atomically; upstream 502 correctly recorded FAILED with zero charge.
- Simulated billing mode exercises the complete money loop without Stripe keys (£27.00 balance trace: £2 grant + £15 Pro + £10 pack, invoices TF-000001/2).
- Money convention: integer micro-GBP everywhere; rates float micros/1K tokens.
- Key files: src/server/gateway.ts (pipeline), src/server/billing/* (ledger, pricing, subscription), src/server/providers/* (abstraction), prisma/schema.prisma (16 models), src/components/taskflow/* (9 components).
- Known limitations (documented in README): in-memory rate limiter (single instance), SQLite dev DB, GPU rental gated to Phase 9, streaming responses not yet supported at gateway.

---
Task ID: 1 (post-summary verification)
Agent: main (Super Z)
Task: Re-verify TaskFlow core platform health after conversation context reset; re-communicate status in English (user could not read the previous Chinese summary).

Work Log:
- Read worklog.md + README.md: confirmed Task ID 1 (Phases 1-7 core) was fully built and verified in the prior session.
- Checked dev.log: server clean, all routes 200, no runtime errors.
- bun run lint: clean, zero errors.
- Re-ran scripts/e2e-api-test.sh (output to scripts/e2e-last-run.log): EXIT_CODE=0, all 16 steps passed (health, auth, key lifecycle, metered gateway calls, entitlement gating, ledger trace, simulated Pro upgrade, credit pack, invoices, burst rate limiting, revoke, webhook idempotency).

Stage Summary:
- Platform state: DELIVERED and HEALTHY. No code changes required in this session.
- Verified live: Free-plan entitlement block works; taskflow-reasoning metered at 120 micros on Pro; ledger shows full balance trace; webhook duplicates correctly flagged; revoked keys fail auth.
- Next per README §35: Phase 8 (shared-compute scheduling), Phase 9 (GPU rental lifecycle), Phase 10 (production hardening) — awaiting owner go-ahead; master context says do not jump to GPU phase until core is validated in real use.

---
Task ID: 2
Agent: main (Super Z)
Task: Phase 0 — Architecture Correction per new MASTER_PROJECT_CONTEXT (§1–67, AI cloud + GPU marketplace edition): full codebase audit, 12-part architecture report, and the honesty/security corrections that must precede the org-tenancy refactor.

Work Log:
- Committed the uploaded spec as MASTER_PROJECT_CONTEXT.md (§1–67) — supersedes the §1–41 edition; TaskFlow is now explicitly a two-sided marketplace (shared AI platform + GPU infrastructure marketplace).
- Audited entire codebase (schema, auth, keys, subscriptions, credits, usage, providers, models, Stripe, GPU schema) via direct reads + Explore agent; produced docs/ARCHITECTURE_REPORT.md with the 12 sections required by §66 (current implementation, problems P-1..P-12, security S-1..S-8, missing entities, schema/API/frontend change plans, AWS integration plan, model sourcing plan, GPU marketplace plan, expand-contract migration strategy, phased implementation order).
- KEY FINDINGS: S-1 CRITICAL — webhook applied unverified events in simulated mode (unauthenticated credit-granting endpoint); S-3 double-grant rollover race; S-4 settlement shortfall; S-5 missing rate card = silent £0; P-1 user-is-billing-entity is the largest structural gap (zero org code exists); pricing/ledger/gateway core verified sound.
- FIXED (Phase 0 code): (1) AiModel +status/hostingMode/version/license/sourceUrl; seed marks taskflow-* = LIVE/TASKFLOW_HOSTED, kimi-k3 + llama-3.3-70b = EXTERNAL_API with real license metadata; effective status = declared ∧ provider-configured (registry.isProviderConfigured). (2) Gateway refuses non-LIVE models (503 via router guard); /v1/models lists only entitled ∩ LIVE ∩ configured models; /api/models exposes status/hostingMode/license; Models page shows §50 badges (LIVE / NOT CONFIGURED / COMING SOON) + hosting + license lines. (3) Webhook: simulated mode requires authenticated session and forces metadata.taskflowUserId = session user (can never mint credits for others); live mode without webhook secret → 503; unverified events NEVER applied. (4) Missing ModelPricing rate card → pricing_not_configured 500 + unbilled FAILED event, never free inference. (5) E2E extended to 17 steps (added unauthenticated-webhook 401 regression guard).
- Verified: bun run db:push + reseed OK; bun run lint clean; E2E 17/17 EXIT_CODE=0; dev.log clean (only pre-fix warnings + benign HMR note); honest behavior visible: kimi-k3/llama no longer advertised as callable without credentials.

Stage Summary:
- DELIVERED: Phase 0 complete — audit + report + placeholder-model honesty + S-1 security fix + pricing integrity, per §66. No GPU work, no fake models, no working functionality deleted.
- Architecture report at docs/ARCHITECTURE_REPORT.md is the implementation roadmap: next = spec Phase 1 (Organization/Membership/Invitation, org-scoped authz, AuditLog, /dashboard/team, auth hardening), then Phase 2 org billing (rollover race fix S-3 goes there).
- Pre-production gates documented in report §3: pepper rotation + startup fail-closed on missing pepper (§46), INCOMPLETE sub status, grace enforcement.

---
Task ID: 3
Agent: main (Super Z)
Task: Replace simulated billing with REAL Stripe billing (org-anchored), per TASKFLOW §1–§20.

Work Log:
- SCHEMA: added Organization (billing owner: slug, ownerUserId, stripeCustomerId @unique); Subscription.organizationId @unique (+ pastDueAt, stripeCheckoutSessionId @unique, INCOMPLETE status); CreditAccount.organizationId; CreditTransaction.organizationId + uniqueGrantKey @unique; Invoice.organizationId + stripePaymentIntentId; dropped StripeCustomer table. Two-phase expand→backfill→contract migration (scripts/backfill-orgs.ts) preserved all 7 dev users' data; verified 7 orgs re-pointed.
- CONFIG (§2,§14,§15): env.ts carries all 8 Stripe vars + stripeMode (sk_live_/sk_test_ detection); src/server/startup.ts validateBillingStartup() + billingConfigIssues(); src/instrumentation.ts fails production startup on missing key/webhook secret/price IDs (sk_test_ in prod = loud warning, still real Stripe). Health endpoint exposes billing mode + configIssues.
- LEDGER (§16,§17): grantCredits/debitCredits org-anchored; uniqueGrantKey UNIQUE constraint makes double grants physically impossible (webhook retries, rollover races, cross-path dedupe).
- SUBSCRIPTION (§8–§11): org-anchored ensureOrgSubscription; ensureCurrentPeriod consults Stripe API (authoritative entitlement) before advancing Stripe-paid periods; grants keyed stripe_sub_{id}_{period}; free/manual subs roll over locally (manual_ keys); PAST_DUE keeps entitlement only within PAST_DUE_GRACE_DAYS=7 from pastDueAt; PAYMENT_FAILED/CANCELED/INCOMPLETE never entitle; cancellation never deletes history (downgrade-to-free at rollover).
- FULFILLMENT (§6,§7,§12): src/server/billing/fulfillment.ts is the ONLY state-mutating path — session-level idempotency guard (stripeCheckoutSessionId unique short-circuit), Stripe-API-verified periods (incl. 2025-basil items-nested current_period_*), ownership check (metadata org + customer match), credit-pack amount validated against configured packages, ledger metadata carries stripe_payment_intent_id/checkout_session/event ids.
- ROUTES: webhook rewritten — signature REQUIRED (constructEventAsync; works under Bun/WebCrypto), missing/invalid → 400, secret missing → 503, simulated path DELETED; checkout rewritten — price-ID-driven (no inline price_data), org metadata (organization_id/plan/purchase_type), fail-closed 503 when unconfigured, Free downgrade drives REAL Stripe cancel_at_period_end; NEW GET /api/billing/checkout/verify re-reads session from Stripe API (server-to-server) with ownership validation; subscription cancel/resume drives real Stripe API.
- GATEWAY: authenticateApiKey resolves User→Organization→Subscription (explicit AuthenticatedKey type, fixing pre-existing inference type errors); planEntitled(status, pastDueAt) grace-aware; ledger rows org-anchored.
- FRONTEND (§13): all "Simulated billing" wording removed; modes = Stripe live / Stripe Test Mode badge / Billing not configured; status labels Active/Trialing/Past due/Payment required/Canceled/Free plan; verify-on-return effect (?status=success&session_id=… → /api/billing/checkout/verify → refresh → URL cleaned); pricesConfigured/priceConfigured disable unbuyable items; past-due warning banner.
- STRIPE TEST MODE CONFIGURED: bun run stripe:setup (scripts/stripe-setup.ts) created REAL test products/prices (Pro £30/mo, Max £90/mo, £10/25/50/100 packs) + webhook endpoint (we_1UAuwd…, whsec stored in .env). Price IDs in .env. .env documented (.env ignored by git).
- TESTS (§19): tests/billing/{webhook,fulfillment,config}.test.ts (bun test, isolated db/test-billing.db via bunfig preload): 27 tests / 97 assertions, all passing — valid webhook, invalid/missing/wrong-secret signature, duplicate webhook, Pro/Max checkouts (£15/£50 grants), £10/25/50/100 packs, payment failure + grace semantics, cancellation (history preserved), status sync (6 Stripe statuses + price→plan mapping), duplicate monthly grants (cross-path), production fail-closed (3 cases), dev/test-mode config (3 cases).
- E2E: rewritten (18 steps, EXIT_CODE=0) — real checkout.stripe.com URLs, plan stays Free without payment, credit-pack entitlement gate, pricesConfigured all true, unsigned/invalid webhooks 400, health billing=test.
- LIVE MONEY PROOF: completed TWO real Stripe TEST MODE payments through hosted Checkout via agent-browser (Pro £30/mo subscription + £10 credit pack) → verification-on-return → Pro ACTIVE + £15 allowance (stripe_sub_… key) + £10 PURCHASE (pi_3UAvG9… metadata) → balance £27 exactly; repeat verifies idempotent ("already fulfilled — skipped"). Found+fixed double-grant bug in the process (Stripe basil API moved current_period_* into items; added session-level guard + items fallback; dev-DB duplicate artifact cleaned). Screenshot: scripts/shots/15-billing-real-stripe.png.
- Verification: bun test 27/27 ✓ · eslint clean ✓ · tsc clean (TaskFlow code; 4 pre-existing errors remain in sandbox scaffold skills//examples/) ✓ · next build ✓ · e2e 18/18 ✓.

Stage Summary:
- DELIVERED: real Stripe billing architecture — User→Organization→Stripe Customer→Subscription; zero simulated paths; fail-closed everywhere; exactly-once money movement with full reconciliation (StripeEvent + uniqueGrantKey + invoice mirrors + ledger metadata).
- Target state reached: LOCAL = Stripe TEST MODE (configured & proven with 2 real test payments); PRODUCTION = Stripe LIVE MODE enforced at startup (missing config refuses to boot).
- Remaining billing risks (documented, non-blocking): (1) webhook endpoint currently points at a Vercel 404 domain — must be re-registered to the real deployment host before production (stripe-setup --webhook-url); until then verification-on-return covers fulfillment but webhook-driven renewals need the endpoint; (2) PAST_DUE grace is enforced at gateway but no dunning emails yet; (3) proration on plan switches not implemented (Stripe handles it, TaskFlow mirrors via subscription.updated); (4) single personal org per user — real multi-member orgs land in Phase 1 and reuse this entity unchanged.

---
Task ID: 4
Agent: main (Super Z)
Task: Phase 1 — Real Identity, Authentication & Multi-Tenancy (§1–§51 of the Phase 1 spec): users, organizations, memberships, sessions, OAuth (Google/Microsoft/GitHub), invitations, tenant isolation, while preserving the Phase Stripe billing.

Work Log:
- PLAN: docs/PHASE1_PLAN.md — audited codebase, 13 architectural decisions, expand→backfill→contract migration plan. Key decisions: (1) keep cuid() ids (non-sequential, opaque — spec §2 explicitly permits); (2) Arctic v3 for the OAuth PROTOCOL (state/PKCE/exchange) + keep the existing DB session system (§37 reuse working primitives; next-auth v4 rejected: credentials+DB-session limitation, adapter schema clobber); (3) PasswordCredential as a separate table; (4) Membership = authorization source of truth, Organization.ownerUserId kept as Stripe-flow convenience; (5) active-org httpOnly cookie re-validated against Membership on EVERY request.
- SCHEMA: +PasswordCredential, +AuthenticationIdentity(provider,providerAccountId unique pair), +AuthToken (EMAIL_VERIFY|PASSWORD_RESET, hashed, single-use, expiring), +Membership(org+user unique, role), +Invitation(tokenHash unique, expiresAt, acceptedAt, revokedAt), +AuditLog, +EmailMessage; User +emailVerifiedAt/avatarUrl/status/lastLoginAt, −passwordHash; Session +lastUsedAt/revokedAt/ipAddress/userAgent; ApiKey +organizationId (now org-owned, §27); UsageEvent +organizationId; Plan +maxMembers; Subscription.userId/CreditAccount.userId uniques dropped (multi-member era).
- MIGRATION (scripts/migrate-phase1.ts): INCIDENT + RECOVERY — the additive push dropped User.passwordHash before same-DB backfill was possible; recovered all 11 users' hashes from the git-committed db (db/backups/pre-phase1-HEAD.db), restored 11 PasswordCredential rows by email join, created 11 OWNER memberships, org-anchored 9 API keys + 63 usage events, set Plan.maxMembers (free=3/pro=10/max=25). Script now takes its own safety snapshot first and is idempotent.
- AUTH HARDENING: session revocation (revokedAt kept for audit; reuse-after-logout fails), lastUsedAt, IP/UA capture; fresh token per login (fixation-safe); suspended users locked out; auth rate limiter (sliding window: login per-IP 20/min + per-IP+email 8/min, register 8/10min, reset 5/10min, oauth 20/min, invite-accept 20/10min); uniform login errors (no enumeration); forgot-password always generic; password reset revokes ALL sessions + marks email verified; password change requires current password and revokes other sessions; same-origin check on all mutations; AUTH_SECRET-signed OAuth state cookies.
- EMAIL (§35): transport interface — dev-console (console + EmailMessage outbox, dev-only readable via /api/dev/email-outbox, 404 in production) and Resend for production (fail-closed when unconfigured). Templates: verification (24h), reset (1h), invitation (7d).
- OAUTH (§4–§15): Arctic 3.7 Google/MicrosoftEntraId/GitHub; identity-only scopes (openid email profile / read:user user:email); callbacks derived ONLY from APP_BASE_URL; unconfigured provider → explicit 503 + disabled UI buttons (never faked); ID-token claims validated (iss/aud/exp/nonce); linking policy: known identity → sign-in; VERIFIED provider email matching local user → audited auto-link; UNVERIFIED → refused with connect-from-account guidance (no takeover); link mode binds identity to session user; unlink blocked when it would remove the last credential; provisioning transactional + idempotent (user+org+OWNER+Free sub+credits, §32); provider tokens never persisted.
- TENANCY: server/tenancy/authz.ts (getOrgContext / requireOrgRole / requireOrgMember / roleAtLeast / isLastOwner / same-origin / HMAC) is the ONLY authorization choke point; server/tenancy/org-service.ts createOrganization = single provisioning path; invitations service with plan-derived seat accounting (members + pending; accept excludes the converting invitation itself — found & fixed off-by-one where the last valid seat could never be claimed).
- ROUTES: re-scoped to active org with role floors — keys (list MEMBER/create+revoke ADMIN+), usage, credits, models, invoices (MEMBER read), billing checkout+verify+cancel (OWNER-only, §25); gateway resolves keys via ApiKey.organizationId (legacy rows lazily adopted); /api/auth/me returns orgs[]+role+providers+verification; new routes: verify-email, resend-verification, forgot/reset-password, password/change, sessions (+revoke by id/all), oauth/[provider]{,/callback,/unlink}, orgs, orgs/active, orgs/[orgId]/members(+[userId]), orgs/[orgId]/invitations(+[id]), invitations/lookup+accept, dev/email-outbox.
- FRONTEND: auth view with REAL provider buttons (disabled + config hint when unconfigured), forgot-password flow; org switcher in sidebar (+ new-org dialog); Team page (roster, role badges, seat counter x/max, invite dialog with role select + copyable link when email unconfigured, revoke, role change OWNER-only, remove); Account page (profile, verification + resend, connected providers connect/disconnect, password change, active sessions with device hints + revoke/others, sign-out); hash screens for OAuth finishing, verify-email, reset-password, invite acceptance; types extended.
- STRIPE AUDIT (§47): checkout metadata organization_id intact, fulfillment ownership checks intact, webhook signature enforcement intact, TEST MODE checkout proven in e2e; 27/27 billing tests pass unchanged.
- TESTS (§44): tests/identity/ — password-auth (9: registration provisioning+UUIDs, duplicate 409, login+lastLoginAt, uniform 401s, logout-reuse-401, revoked/expired rejection, rate limiting, /me payload), email-tokens (4: verify+replay+forged, forgot non-enumeration, reset revokes sessions, expiry), oauth (9: state cookie signing, Google/Microsoft/GitHub callbacks with the provider protocol mocked at the fetch boundary — Arctic passes a Request object, the mock resolves input.url — duplicate-callback idempotency, verified-email auto-link, unverified refusal, issuer tampering rejected, last-credential unlink blocked, unconfigured 503), tenancy (14: provisioning, personal-org idempotency, duplicate-membership constraint, multi-org, cookie re-validation, invitation lifecycle + seat limit 3/3 + accept-side atomic recheck, role floors, tampering, 401 typing), isolation (9: org-owned keys, gateway key→org resolution, credit ledger isolation, OWNER-only billing, invoice scoping, usage scoping, switch-endpoint membership validation, revoked keys). TOTAL with billing: 72 tests / 270 assertions, 0 fail.
- E2E: extended to 26 steps (identity bootstrap, email verification + replay block, invitation accept, org switch + MEMBER 403s, seat limit 3/3, logout-reuse-401 + fresh login, audit rows, OAuth honesty) — EXIT_CODE=0. Found & fixed e2e-script bugs (cookie jar not persisting the switch cookie; seat-limit expectation needed a 4th invite).
- VERIFICATION: eslint clean; tsc clean (TaskFlow code; pre-existing sandbox scaffold errors in skills//examples/ unchanged); next build ✓ (all new routes compiled); browser-verified via agent-browser: signup → dashboard (org switcher shows "…'s Workspace OWNER"), Team page invite → pending list + shareable link, Account page (unverified badge + resend, connect buttons, sessions with this-device, revoke others), sign-out → sign-in round trip, mobile viewport hamburger layout; dev.log clean (queries visibly org-scoped).

Stage Summary:
- DELIVERED: Phase 1 — real identity + multi-tenancy on top of the untouched real Stripe billing: User→Membership→Organization (tenant + billing owner), DB sessions with revocation, email/password + email verification + password reset, OAuth with a verified-email-only auto-link policy and explicit connect/unlink, invitations with DB-backed Free seat limit (3), centralized role authorization (OWNER/ADMIN/MEMBER), every org-owned resource tenant-scoped server-side, AuditLog + EmailMessage records, honest OAuth configuration states.
- Remaining operator setup (no code): create OAuth apps in Google/Microsoft Entra/GitHub consoles with exact callbacks {APP_BASE_URL}/api/auth/oauth/{provider}/callback, fill *_CLIENT_ID/SECRET; set AUTH_SECRET (production-fatal without it) and APP_BASE_URL=https://taskflow.web-agent.org; configure RESEND_API_KEY for real email delivery; re-register the Stripe webhook endpoint to the production host (pre-existing note).
- Known limits (documented): OAuth ID tokens validated at claims level (iss/aud/exp/nonce; signature check documented as defense-in-depth per OIDC for TLS-direct tokens); in-memory rate limiting (single instance, Redis swap point ready); email change not implemented; no dunning emails yet.

---
Task ID: 5
Agent: main (Super Z)
Task: Authentication correction & production identity hardening — finalization (env keys, multi-environment origins, CSRF status-code fix, verification, final report).

Work Log:
- Audited the correction-session state: Auth.js (next-auth v5 beta.32) migration already complete (src/server/auth/authjs/*: config+adapter+policy+provider-map, [...nextauth] route, credentials driven through Auth() into DB sessions), phone verification (src/server/auth/phone.ts + phone/request|confirm routes + PhoneVerificationChallenge), pluggable SMS (src/server/sms: dev | twilio | unconfigured fail-closed), EmailProvider (dev outbox | Resend), 84 tests passing. Git tree clean.
- MULTI-ENVIRONMENT ORIGINS: one codebase now fronts localhost:3000 (dev), the sandbox preview (https://preview-chat-970b43ea-568a-4d4b-b88d-383d3eae4f1d.space-z.ai), and production (https://taskflow.web-agent.org, Vercel-hosted). Added serverEnv.trustedOrigins (APP_BASE_URL + TRUSTED_ORIGINS) and extracted the origin decision into edge-safe src/server/origin.ts (single source of truth).
- NEW src/proxy.ts (Next.js 16 global proxy/middleware): cross-site mutating /api requests now get a proper 403 JSON BEFORE route handlers — fixes a found defect where auth routes without an OrgContextError mapper answered CSRF rejections with 500 (verified live: evil origin 403, preview/localhost/webhook-style requests unaffected). authz.ts assertSameOrigin kept as defence in depth, delegating to origin.ts.
- .env COMPLETED per owner request (owner: "put all the keys in there"): generated AUTH_SECRET (openssl rand -base64 48), APP_BASE_URL=https://preview-chat-970b43ea-568a-4d4b-b88d-383d3eae4f1d.space-z.ai, TRUSTED_ORIGINS=localhost+preview+production, SMS_PROVIDER=dev (codes in SmsMessage outbox), existing Stripe TEST keys/prices + pepper kept; OAuth client IDs/secrets left empty-with-instructions (they require real provider-console registration; never faked).
- .env.example rewritten: deployment-environment matrix (localhost / preview / production+Vercel), per-environment OAuth callback URLs, Vercel server-side env-var notes (incl. hosted-DB prerequisite for production), TRUSTED_ORIGINS documented.
- tests/setup.ts made hermetic: pins APP_BASE_URL=http://localhost:3000 so tests never depend on the ambient deployment .env (found via 2 transient oauth-test failures after the .env change — Auth.js folds cross-origin policy redirects to the bare request origin).
- VERIFICATION: bun test 84/84 (27 billing + 57 identity incl. 12 phone-verification); eslint clean; tsc clean (TaskFlow code); next build succeeds with Proxy (Middleware) compiled; e2e 26/26 EXIT_CODE=0; live preview URL verified end-to-end (/api/auth/me, /api/health, real registration 201 through the preview origin).
- Wrote docs/AUTH_HARDENING_REPORT.md — the 15-part final report (framework, email/phone verification, OAuth x3, sessions, org/membership models, tenant isolation, email/SMS transports, Stripe, env vars, Vercel, verification results, remaining blockers).

Stage Summary:
- DELIVERED: all 22 correction items verified; the deployment runs with every supplyable key filled and recognizes both development fronts + the production front.
- Owner-visible outcomes: preview URL is a first-class dev environment (OAuth callbacks to register: {preview}/api/auth/callback/{provider}); production taskflow.web-agent.org config goes in Vercel env vars (APP_BASE_URL=https://taskflow.web-agent.org there); OAuth buttons activate the moment real client IDs/secrets are added to .env (dev) or Vercel (prod).
- Remaining (no code): register OAuth apps + callbacks in provider consoles; RESEND_API_KEY for production email; Twilio credentials for production SMS; hosted Postgres before the Vercel production cutover (SQLite is dev-only); re-register the Stripe webhook endpoint to the final production host.

---
Task ID: 5-b
Agent: main (Super Z)
Task: Sign-in UX follow-up — make the email/password signup flow completable from the browser on deployments running dev transports (owner was viewing the sign-in screen from the preview URL).

Work Log:
- Found the friction: on this deployment email/SMS are dev transports, so verification links/codes were only reachable by manually hitting /api/dev/*-outbox — the UI gave no path, stalling signup at "verify your email".
- NEW src/components/taskflow/dev-outbox-helper.tsx — honest, production-safe dev panel: fetches the email/SMS outbox, extracts the action link (#/verify-email|reset-password|invite?token=…) or the 6-digit code, offers "Open verification link" / "Use this code". Renders NOTHING when the dev endpoints 404 (production), and is explicitly labelled "Development outbox".
- Wired into PendingVerificationScreen (email step + phone step, refresh-tracked after resend/send) and the forgot-password confirmation in auth-view.
- Fixed a wrong link-extraction regex (real SPA hash routes are #/verify-email etc., not #/auth/verify-email).
- Routing guard: #/auth/pending with no session now bounces to sign-in instead of rendering a meaningless "Pending" state (mixed-origin testing artifact made this reachable).
- scripts/dev-helper-e2e.sh — 9-step simulation of the helper's exact data path through the LIVE preview URL (register → outbox link → verify → SMS request → outbox code → activate). PASS=9 FAIL=0. Gotchas fixed: '+' must be percent-encoded in outbox ?to= filters (component already does).
- Browser-verified END-TO-END on the preview URL via agent-browser: signup → dev outbox panel → open link → email verified → phone code surfaced → Use this code → Verify and activate → dashboard "Preview User's Workspace" OWNER £2.00 FREE. Screenshots: scripts/shots/20-21.
- Cleaned test artifacts (4 users + outbox rows). lint clean; typecheck clean (TaskFlow code); e2e 26/26 EXIT=0 re-confirmed.

Stage Summary:
- Signup is now fully completable from the preview URL UI: verification link and SMS code are surfaced in-page (dev deployments only). Production behavior unchanged (helper self-hides; outbox routes 404).
- Social sign-in remains truthfully disabled until real Google/Microsoft/GitHub client IDs/secrets are configured — never faked (§16).
