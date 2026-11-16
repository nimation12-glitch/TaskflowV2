# TaskFlow

A GPU rental and AI compute platform: rent NVIDIA GPUs by the hour or day,
top up a wallet, call AI models through an OpenAI-compatible API, and manage
it all from a dashboard.

**This is a real-money product.** Billing is real Stripe (GBP), GPU rentals
provision real AWS instances that cost real money, and the billing ledger is
append-only. Nothing in the codebase simulates success — if a payment or a
provisioning dependency is not configured, the relevant feature refuses to
run rather than pretending to work.

## Architecture

| Piece | Technology | Hosted on |
|---|---|---|
| Frontend | Next.js 14 (App Router), NextAuth v5, Prisma | Vercel |
| Backend | FastAPI, SQLAlchemy 2, Alembic | Render |
| Database | Postgres 18 (Neon) | Neon |
| Payments | Stripe (Checkout, Customer Portal, webhooks) | — |
| GPU provisioning | AWS EC2 (boto3, scoped IAM policy in `infra/`) | — |

The single Neon database (`Taskflow-Users`) is shared by both halves, in two
separate schemas, migrated independently:

- `public` — backend domain tables (organizations, plans, subscriptions,
  credit ledger, invoices, GPU catalog/rentals, usage events). Owned by
  Alembic (`backend/alembic`).
- `auth` — NextAuth identity tables (users, accounts, sessions,
  verification tokens, password reset tokens). Owned by Prisma
  (`frontend/prisma/schema.prisma`) via `?schema=auth` in the frontend's
  `DATABASE_URL`.

The frontend never talks to the FastAPI backend from the browser for
session-bound routes. Next.js server code resolves the NextAuth session,
mints a short-lived (60s) HS256 JWT signed with the shared `AUTH_SECRET`,
and proxies the call (`frontend/lib/backend-client.ts`). The backend
verifies that token (`backend/app/auth/internal.py`) — it never trusts a
raw user/org id from a request parameter. See `docs/AGENTS.md` for the full
contract, including the append-only rules the codebase depends on.

## Repository layout

```
backend/    FastAPI app (app/api routes, app/services logic, app/models),
            Alembic migrations, pytest suite, scripts/ (seeding, smoke tests)
frontend/   Next.js app — app/(app) dashboard routes, app/api route handlers,
            lib/ backend clients, prisma/ identity schema, scripts/
infra/      docker-compose.yml (local Postgres) and aws-iam-policy.json
docs/       gpu-rental-setup.md (deployment checklist), AGENTS.md (contracts)
```

## Local development

Requirements: Python 3.11, Node.js LTS, a Postgres 16+ database (local or
Neon), and real service credentials for anything you want to exercise
(Stripe, AWS, SMTP — see `.env.example` files for the full list).

```bash
# Backend
cd backend
python -m venv .venv && .venv\Scripts\pip install -r requirements.txt   # Windows
alembic upgrade head
python -m scripts.seed        # plans, GPU catalog, model pricing — idempotent
uvicorn app.main:app --reload # http://localhost:8000, docs at /docs

# Frontend
cd frontend
npm ci
npx prisma generate
npm run dev                   # http://localhost:3000
```

Both `.env` files must be created from the `.env.example` files. The two
secrets `AUTH_SECRET` and `BACKEND_SERVICE_SECRET` must match exactly across
the two files — the JWT handshake depends on it. Money everywhere is integer
micro-GBP; never introduce floats.

## Deployment

- **Backend → Render**: Python 3.11 (`runtime.txt`). `ENVIRONMENT=production`
  makes startup refuse to run if any required secret is missing
  (`validate_production_config()` in `app/config.py`) — that is deliberate.
- **Frontend → Vercel**: env vars set in the Vercel project settings.
- **Stripe webhooks** point at `<backend>/webhooks/stripe`; events are
  processed idempotently (see `StripeEvent` table).
- **GPU safety sweep**: `POST /internal/gpu/sweep` (protected by
  `GPU_SWEEP_SERVICE_SECRET`) must be called every 2–5 minutes by an
  external scheduler — see `docs/gpu-rental-setup.md` before enabling GPU
  rentals in production.

## Known gaps

Documented honestly in `docs/gpu-rental-setup.md` §5: no automatic refund
flow when AWS provisioning fails after a successful payment (manual Stripe
review), and transitional rental states (`PENDING_PAYMENT`, `STOPPING`) are
collapsed rather than shown.
