# AGENTS.md — working contracts for TaskFlow

This document explains the invariants that make TaskFlow safe to change.
Read it before touching billing, auth, or GPU code. It exists because the
code references it (`frontend/prisma/schema.prisma`) and because agents and
humans keep needing the same answers.

## 1. The database is shared but split

Both halves point at the same Neon Postgres database (`Taskflow-Users`) but
migrate **independent schemas**:

- **Backend (FastAPI + SQLAlchemy + Alembic)** owns `public`. Every backend
  table (organizations, memberships, plans, subscriptions, credit ledger,
  invoices, stripe tables, gpu_types/gpu_instances, usage_events, api_keys,
  system_settings, account_statements) lives there.
- **Frontend (Next.js + Prisma)** owns `auth`. The frontend's
  `DATABASE_URL` carries `?schema=auth` so the NextAuth adapter tables
  (`users`, `accounts`, `sessions`, `verification_tokens`,
  `password_reset_tokens`) live in that schema. The backend never reads or
  writes the `auth` schema.

Consequences:

- `user_id` / `organization_id` values are shared UUIDs, but there is no
  cross-ORM foreign key. Integrity is enforced at the application layer via
  the signed-JWT service boundary (`backend/app/auth/internal.py`).
- Run `alembic upgrade head` from `backend/` for backend schema changes;
  run Prisma migrations from `frontend/` for identity changes. Never let
  one tool "fix" the other's schema.
- Historical note: `Taskflow-Users.auth` contains stale duplicates of
  backend tables and the `neondb` database is an empty leftover. Neither is
  referenced by live code; cleaning them up is a manual, confirmed operation.

## 2. The service boundary is signed JWTs, never raw ids

Browser → Next.js (NextAuth session + active org/role) → FastAPI with a 60s
HS256 token asserting `{ sub, org_id, role, is_platform_admin }`, signed with
the shared `AUTH_SECRET`. The backend decodes and re-derives identity from
the claims only. There is no fallback to request parameters for user/org
identity, and there must never be one.

`is_platform_admin` is **claim-only**: it is set directly in the identity
database (`frontend/scripts/set-platform-admin.ts <email>`), never through
any API or UI, and the backend only trusts it when it arrives on a verified
token.

## 3. Money is integer micro-GBP. Always.

`1 GBP = 1_000_000 micros`. Every monetary column is `BigInteger` micros
(`MICROS_PER_GBP` in `app/models/billing.py`). Stripe's pence convert via
`× 10_000`. Never introduce floats, never round in models — format only at
the display edge.

## 4. The credit ledger is append-only

`credit_transactions` is an append-only double-entry-style ledger
(`balance_after_micros` makes it self-verifying). Balances live in
`credit_accounts.balance_micros` but are always changed through
`app/services/credits.py::record_transaction`, which writes the ledger row
in the same transaction. Never `UPDATE` a ledger row. Never mutate a
balance without a ledger row.

Monthly subscription credits are granted **only** in
`handle_invoice_paid`, guarded by `last_credit_grant_period_start` plus the
`stripe_events` idempotency table — webhook retries must never double-grant.

## 5. Statements are immutable documents

`account_statements` (added by migration `d4e8f2b1c7a9`) stores read-only
JSON snapshots of an organization's billing state. Rules:

- Generation appends a **new row**; no code path updates or deletes rows.
- `content_sha256` = SHA-256 over canonical JSON (`json.dumps`,
  sort_keys, no whitespace). The read path re-verifies and raises
  `StatementTamperedError` on mismatch instead of serving altered numbers.
- The statement is assembled only from append-only sources (ledger,
  invoices, rental history) so it can never contradict its sources.
- Endpoints (`GET /billing/statement`, `/statement/history`,
  `/statement/{id}`) are OWNER-only. The frontend download flows through
  `frontend/app/api/statement/route.ts`.

## 6. GPU rentals: server-side enforcement, lazy billing

Plan limits (concurrent rentals, storage, session hours, booking window)
are enforced in `app/services/gpu_rentals.py`, never trusted from the
client. Billing is lazy-metered in `gpu_billing.py`: every read of a
RUNNING rental catches up billing, and `POST /internal/gpu/sweep`
(`GPU_SWEEP_SERVICE_SECRET`, called externally every 2–5 min) reconciles
rentals nobody is watching. A rental nobody is watching keeps burning real
AWS spend until the sweep runs — the external cron is not optional.

If AWS provisioning fails after Stripe captured payment, the rental is
marked FAILED with a clear `error_detail` and needs a manual refund decision
in the Stripe dashboard. No code path pretends it succeeded; no automatic
refund exists yet.

## 7. Nothing simulates

If a dependency isn't configured (Stripe keys, AWS credentials, SMTP in
production), the affected feature raises/refuses rather than faking
success. In production, `validate_production_config()` blocks startup when
required secrets are missing. Preserve this property — a "helpful" mock is
a real bug here.

## 8. Workspaces + persistent storage (spec §4–§7, §22, §25)

A workspace is a persistent environment (named storage + SSH identity) that
outlives GPU rentals; rentals reference `GpuInstance.workspace_id` and never
own it, and at most ONE active rental is attached at a time.

- Slots are hard account-level limits (`Plan.included_workspaces`); extra
  slots are not sold. Deleting a workspace (soft delete) releases the slot.
- A size equal to `Plan.workspace_storage_gb` is the plan entitlement: it is
  creatable even when the `StorageSize` row is disabled and is NEVER billed.
- Paid sizes bill hourly while the workspace exists — GPU running, stopped
  or released — via lazy metering in `workspace_storage.py` on the same
  `POST /internal/gpu/sweep` cron. Wallet-empty workspaces are flagged
  `payment_overdue_at`, never auto-deleted; deletion is always explicit.
- `30-day prepaid` (`STORAGE_PREPAID`) is a one-off wallet draw; expiry
  reverts to hourly metering so customer data is never silently destroyed.
- All `StorageSize` rows seed `enabled=False`: paid storage stays
  unpurchasable until real storage provisioning lands. Same rule as
  `GpuType.enabled` — nothing is sold that isn't really provisioned.

## 9. Regions, the scheduler and regional AMIs (spec §12–§15, §19–§24)

Customers pick a GPU, never an AWS region; they may give a location
preference (Automatic / UK / Europe / North America / Asia, §13).

- `regions` + `gpu_region_availability` (migration `b8e2f5a7c1d4`) hold the
  6-region launch matrix seeded by `scripts/seed.py`: exact
  per-configuration premiums (§12 forbids family premium × GPU count),
  `NOT_OFFERED` for every spec N/A, and `aws_cost_est = base + premium` for
  the safe-cost input. Premiums are never plan-discounted (§24).
- `app/services/scheduler.py` turns the matrix into ordered launch
  candidates: hard filters (preference, N/A, disabled region, storage/SSH
  support, safe-cost §19) then ordering by measured startup p50 (§14) and
  premium. `None` = SKU has no matrix (legacy single-region path via
  `GpuType.aws_region`/`ami_id`); `[]` = temporarily unavailable (§19,
  surfaced as 503, never a silent loss-making launch).
- Capacity is AWS's answer at launch time: `create_rental` walks the
  candidates and falls back to the next region on
  `InsufficientInstanceCapacity`, re-snapshotting `hourly_rate_micros` to
  the region actually launched in. Rate snapshot = discounted base +
  regional premium + storage add-on, stored with `region_code` /
  `availability_zone` / `regional_premium_micros` on the rental.
- Wallet reserve (§20): cover for `minimum_rental_hours` before launch;
  ULTRA tier (A100/H100) enforces at least 4 hours.
- AMI ids are regional and must never be copied between regions (§15):
  `app/compute/ami_resolver.py` resolves them from the public SSM parameter
  `/aws/service/deeplearning/ami/x86_64/oss-nvidia-driver-gpu-pytorch-2.13-amazon-linux-2023/latest/ami-id`
  per region and caches on the availability row with a 24h TTL. SSM failure
  = region not viable, never a guessed AMI.
- EC2 key pairs are regional: `SshKey.aws_key_pair_regions` tracks where a
  key was imported; `ensure_aws_key_pair(db, key, region_name=...)` imports
  lazily per launch region, and key deletion cleans up every tracked region.
- `GpuInstance.region_code` is authoritative for every later AWS call
  (stop/start/terminate/describe in `gpu_billing.py` too) — NULL means
  legacy instance in `settings.aws_region`.

## 10. Local development realities

- Windows machines: use `npm.cmd` (execution policy blocks `npm.ps1`).
- The backend venv is `backend/.venv` (Python 3.11 per `runtime.txt`).
- Stripe test mode locally; live keys only on the deployed services.
- Seed scripts are idempotent and safe to re-run.
- For Alembic DDL against Neon, prefer the **direct** (non-`-pooler`)
  endpoint; the pooler is for application traffic.
