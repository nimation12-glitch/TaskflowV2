# Phase 1 — Real Identity, Authentication & Multi-Tenancy

Implementation + migration plan derived from the audited codebase (STEP 1).

## 0. Audited starting point

| Area | State before Phase 1 |
|---|---|
| Password auth | scrypt (`src/server/auth/password.ts`), hash stored on `User.passwordHash` |
| Sessions | DB-backed, sha256 token hash, httpOnly cookie `tf_session`, 30 d TTL; **no** revocation flag, `lastUsedAt`, IP/UA capture |
| OAuth | none (no provider code at all) |
| Email | no email service, no verification, no password reset |
| Rate limiting | gateway keys only (`src/server/ratelimit.ts`); auth endpoints unlimited |
| Tenancy | `Organization` = billing owner (real Stripe). No `Membership`, no invitations, no roles. Org resolution hardcodes one-personal-org-per-user (`ownedOrganizations[0]`) |
| Ownership anchors | `ApiKey.userId`, `UsageEvent.userId`; `Subscription.userId @unique`; `CreditAccount.userId @unique` |
| Stripe | real, org-anchored, webhook-verified, idempotent — must not regress (§47) |

## 1. Architectural decisions (with rationale)

1. **Public identifiers stay `cuid()`** — non-sequential, opaque, stable. Spec §2 permits this instead of `usr_`/`org_` prefixes; no churn to existing billing rows.
2. **OAuth protocol via Arctic v3** (mature client library from the Lucia project). Arctic handles authorize-URL construction, state, PKCE and token exchange for Google / Microsoft Entra ID / GitHub. Rationale: `next-auth` v4 is installed but legacy; its credentials+database-session limitation and its adapter schema would clobber the existing revocation-capable session model. §37 instructs reusing working security primitives; Arctic satisfies §10/§38 (mature library, no hand-rolled OAuth exchange). Sessions remain the existing DB-backed implementation for **all** login methods.
3. **`PasswordCredential` as a separate table** — OAuth users have no password row; clean normalization per §16.
4. **`Membership` is the authorization source of truth** (role OWNER/ADMIN/MEMBER, unique per org+user). `Organization.ownerUserId` is retained as a denormalized billing convenience (Stripe flows read it) and is kept consistent transactionally.
5. **Active-organization context** — httpOnly `tf_org` cookie stores the desired org id; the server re-validates membership on **every** request (cookie is never trusted alone, §23). No org context ⇒ first membership (personal org).
6. **Free-plan seat limit is DB-backed** — `Plan.maxMembers` (free = 3: OWNER + 2), server-enforced; counts active memberships + pending invitations (§20).
7. **OAuth account-linking policy** (§7): sign-in resolves identity → user. When the provider returns a **verified** email matching an existing local user, auto-link (audited). Unverified provider e-mail + existing account ⇒ refuse with an explicit "connect from Account page" error — no takeover path. Explicit linking/unlinking is a signed-in account-page action; the last usable credential can never be removed.
8. **OAuth callback idempotency** (§32): user provisioning runs in one transaction guarded by unique constraints (email, provider+account, org slug random suffix, membership unique).
9. **Tokens (email verification, password reset, invitations)** are stored as sha256 hashes, single-use, expiring; invitation links carry 32-byte high-entropy tokens (§19). Password reset revokes all sessions.
10. **Email service behind an interface** (§35): dev transport = console + `EmailMessage` outbox (readable via a **non-production-only** endpoint so the sandbox flow is testable); production transport = Resend API (env-gated), loud fail-closed warnings when unconfigured.
11. **Missing provider credentials** (§4/§12/§30): `/api/auth/providers` reports per-provider configured state; UI renders disabled buttons with a configuration hint. Nothing pretends OAuth works. Callback URLs are always derived from trusted server config (`APP_BASE_URL`/`API_BASE_URL`), never from request Host headers (§39).
12. **CSRF** — SameSite=lax cookies + JSON-only mutating endpoints + same-origin check on auth mutations. OAuth state is an HMAC(AUTH_SECRET)-signed, httpOnly, 10-minute cookie (§10).
13. **Rate limiting** (§34): in-memory sliding windows per IP (and IP+email for login/reset), mirrored on the existing `ratelimit.ts` pattern.

## 2. Schema changes (STEP 3)

**New tables:** `PasswordCredential`, `AuthenticationIdentity`, `Membership`, `Invitation`, `AuditLog`, `EmailMessage`, `AuthToken` (verification/reset tokens).

**Changed tables:**
- `User`: +`emailVerifiedAt?`, +`avatarUrl?`, +`status` (ACTIVE|SUSPENDED), +`lastLoginAt?`; −`passwordHash` (→ PasswordCredential, contract phase)
- `Session`: +`lastUsedAt?`, +`revokedAt?`, +`ipAddress?`, +`userAgent?`
- `Organization`: +`status` (ACTIVE|SUSPENDED)
- `Plan`: +`maxMembers` (default 3)
- `ApiKey`: +`organizationId?` → becomes the ownership anchor (backfill; `userId` = creator attribution)
- `UsageEvent`: +`organizationId?` (backfilled)
- `Subscription.userId`: @unique dropped (attribution only)
- `CreditAccount.userId`: @unique dropped (attribution only)

## 3. Migration (STEP 4) — `scripts/migrate-phase1.ts`

Expand → backfill → contract, SQLite-safe, **preserves all dev billing data**:
1. Push additive schema (new tables/columns nullable).
2. Backfill: `PasswordCredential` rows from `User.passwordHash`; OWNER `Membership` per org; `ApiKey.organizationId` / `UsageEvent.organizationId` from creator's personal org; `Plan.maxMembers`; default org status. Idempotent (re-runnable).
3. Contract push (drop `User.passwordHash`, drop the two @uniques) **after** code reads the new locations.

## 4. Implementation order (§48)

| Step | Delivers |
|---|---|
| 5–6 | Credentials table, session revocation/lastUsedAt/IP/UA, auth rate limiting, email service, verification + password reset flows, audit log |
| 7–9 | Arctic OAuth: Google → Microsoft → GitHub; state/PKCE; sign-in, verified-email auto-link, explicit link/unlink; idempotent provisioning (user + org + OWNER membership + Free subscription + credit account) |
| 10+12+14 | `requireSession`/`getOrgContext`/`requireOrgRole` helpers; re-scope `/api/keys`, `/api/usage`, `/api/credits`, `/api/models`, `/api/billing/*` to the active org; billing mutations OWNER-only; gateway resolves keys via `ApiKey.organizationId` |
| 11 | Invitations service + routes; DB-backed seat limit; token-hash invitations; accept flow with validation chain (§21) |
| 13 | Frontend: Team page (`#/dashboard/team`), Account page (`#/dashboard/account`), org switcher, OAuth buttons with real configured state, forgot/reset password UI, verify-email + auth-callback screens |
| 15 | Stripe regression audit: billing test suite re-run, checkout/webhook paths re-inspected for org anchoring |
| 16 | `tests/identity/*` — 26 required scenarios; billing suite stays green; e2e extended |
| 17 | lint + typecheck + build + browser verification |

## 5. New API surface

```
POST /api/auth/register | login | logout           (hardened)
GET  /api/auth/me                                   (orgs[] + active org + role + providers + verification)
GET  /api/auth/providers                            (OAuth configuration state)
POST /api/auth/verify-email | resend-verification
POST /api/auth/forgot-password | reset-password
POST /api/auth/password/change
GET  /api/auth/oauth/[provider]                     (begin — sign-in or link)
GET  /api/auth/oauth/[provider]/callback
POST /api/auth/oauth/[provider]/unlink
GET  /api/auth/sessions        DELETE /api/auth/sessions/[id] | ?scope=all
GET/POST /api/orgs             POST /api/orgs/active
GET  /api/orgs/[orgId]/members     PATCH/DELETE /api/orgs/[orgId]/members/[userId]
GET/POST /api/orgs/[orgId]/invitations          DELETE /api/orgs/[orgId]/invitations/[id]
GET  /api/invitations/lookup    POST /api/invitations/accept
GET  /api/dev/email-outbox                          (non-production only)
```

## 6. Environment template (§11)

`AUTH_SECRET`, `APP_BASE_URL`, `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID`, `GITHUB_CLIENT_ID/SECRET`, email transport vars — all in `.env.example`; production startup refuses to run without `AUTH_SECRET` (fail-closed, same policy as Stripe).
