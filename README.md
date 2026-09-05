# TaskFlow

Unified AI API gateway + credit billing + (future) GPU marketplace.

This repo implements Phase 0/1 of the architecture spec: real multi-tenant
identity (NextAuth.js + Google/Microsoft/GitHub OAuth + email/password), real
Stripe subscription + credit billing, organizations/teams, API keys, and an
OpenAI-compatible AI gateway with a pluggable provider abstraction.

**GPU rental, the community GPU marketplace, and AWS provisioning are
intentionally not implemented yet** — per the architecture spec these are
later phases (8/9), and the compute dashboard page says so honestly rather
than showing fake GPU instances.

## Architecture

```
Browser
  │
  ▼
Next.js (Vercel) ── NextAuth.js: Google / Microsoft / GitHub / email+password
  │                  Prisma → Postgres (users, accounts, sessions)
  │
  │  server-side only, short-lived signed JWT (AUTH_SECRET)
  ▼
FastAPI backend ── organizations, billing, credits, API keys, usage, AI gateway
  │                 SQLAlchemy + Alembic → same Postgres (separate tables)
  ▼
Stripe (real Checkout + webhooks)   /   External AI providers (NVIDIA, Moonshot, OpenRouter)
```

Two migration tools manage the same Postgres database: Prisma owns the
identity tables (`users`, `accounts`, `sessions`, `verification_tokens`,
`password_reset_tokens`); Alembic owns everything else (organizations,
billing, API keys, usage, model catalog). They never touch each other's
tables. See `backend/app/models/org.py` and `frontend/prisma/schema.prisma`
for the reasoning.

## Repository layout

```
TaskFlow/
  backend/         FastAPI control plane
    app/
      api/         REST routes
      auth/        JWT verification (session token + service secret)
      billing/     Stripe integration
      models/      SQLAlchemy models
      providers/   AI provider adapters (NVIDIA/Moonshot/OpenRouter)
      services/    Business logic (credits ledger, invitations, pricing...)
    alembic/       DB migrations
    scripts/seed.py
    tests/
  frontend/        Next.js 14 app (deploy to Vercel)
    app/           Pages + API routes
    prisma/        Identity schema (NextAuth adapter tables)
    lib/           Backend client, internal JWT signing, email abstraction
  infra/
    docker-compose.yml   local Postgres only
```

## Local development

### 1. Database

```bash
cd infra && docker compose up -d
```

### 2. Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# generate secrets:
python -c "import secrets; print(secrets.token_urlsafe(64))"   # run 3x for
#   AUTH_SECRET, TASKFLOW_API_KEY_PEPPER, BACKEND_SERVICE_SECRET
alembic revision --autogenerate -m "init"
alembic upgrade head
python -m scripts.seed
uvicorn app.main:app --reload --port 8000
```

### 3. Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local
# AUTH_SECRET and BACKEND_SERVICE_SECRET MUST exactly match the backend's .env
npx prisma migrate dev --name init
npm run dev
```

Visit http://localhost:3000. Email/password signup works immediately.
OAuth buttons are disabled until you configure the providers below.

## Setting up real external accounts

Nothing in this codebase fakes these — every integration is a real API call.
The values below are the only things that don't exist until you create them.

### Stripe (required for billing)

1. Create an account at https://dashboard.stripe.com (test mode is fine for dev).
2. **Products → Add product** — create three recurring products: **Pro** (£30/mo)
   and **Max** (£90/mo), plus one-time-payment products for credit packages
   (£10, £25, £50, £100). Copy each **Price ID** (`price_...`).
3. **Developers → API keys** — copy the **Secret key** (`sk_test_...`).
4. **Developers → Webhooks → Add endpoint**: URL = `https://<your-backend>/webhooks/stripe`,
   events = `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy the
   **Signing secret** (`whsec_...`).
5. For local testing, run `stripe listen --forward-to localhost:8000/webhooks/stripe`
   instead (gives you a local `whsec_...`).
6. Fill in `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`,
   `STRIPE_PRICE_MAX`, `STRIPE_PRICE_CREDIT_10/25/50/100` in `backend/.env`.

**Note:** rotate any Stripe key that has ever been pasted into a chat, document,
or shared file — treat it as compromised the moment it left the Stripe dashboard.

### Google OAuth

1. https://console.cloud.google.com/apis/credentials → **Create credentials
   → OAuth client ID** → Application type: **Web application**.
2. Authorized redirect URI: `http://localhost:3000/api/auth/callback/google`
   (dev) and `https://<your-domain>/api/auth/callback/google` (prod).
3. Copy **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` in `frontend/.env.local` (and Vercel env vars).

### Microsoft (Entra ID) OAuth

1. https://portal.azure.com → **Microsoft Entra ID → App registrations → New
   registration**. Supported account types: choose based on who should be able
   to sign in (personal + work/school = use `common` as the tenant).
2. Redirect URI (platform: Web): `http://localhost:3000/api/auth/callback/microsoft-entra-id`
   and the production equivalent.
3. **Certificates & secrets → New client secret** — copy its value immediately
   (shown once).
4. Fill in `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`.

### GitHub OAuth

1. https://github.com/settings/developers → **New OAuth App**.
2. Authorization callback URL: `http://localhost:3000/api/auth/callback/github`
   (dev) and the production equivalent.
3. Copy **Client ID**, generate and copy a **Client secret**.
4. Fill in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

### AI providers (optional — for the gateway to actually serve models)

Set whichever of `NVIDIA_API_KEY`, `MOONSHOT_API_KEY`, `OPENROUTER_API_KEY`
you have. Un-configured providers are simply omitted — models tied to them
show as "Not configured" rather than pretending to work.

## Deploying

- **Frontend**: Vercel. Set all `frontend/.env.local.example` vars as Vercel
  project env vars. Update OAuth redirect URIs to your production domain.
- **Backend**: any container host with outbound internet (Fly.io, Railway,
  Render, AWS ECS/App Runner). It refuses to start (`validate_production_config`
  in `app/config.py`) if `ENVIRONMENT=production` and required secrets are
  missing — this is intentional, not a bug.
- **Database**: managed Postgres (RDS, Neon, Supabase). Run both `alembic
  upgrade head` (backend) and `npx prisma migrate deploy` (frontend) against it.

## Tests

```bash
cd backend && python -m pytest tests/ -v
```

19 tests covering the credit ledger, API key hashing/authentication,
invitation seat limits, and Stripe webhook idempotency/signature enforcement.
