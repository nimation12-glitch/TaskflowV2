# TaskFlow — Backend (API)

Next.js API deployment: all `/api/**` route handlers (auth, orgs, billing,
keys, usage, gateway), Prisma + database, the CSRF/CORS proxy gate and the
startup fail-closed validation. The product UI lives in `../frontend`
(Vercel). The two talk over `FRONTEND_BASE_URL` (backend → frontend, for
redirects and email links) and `NEXT_PUBLIC_API_BASE_URL` (frontend →
backend, for fetch calls).

## Run locally

```bash
bun install            # or npm install
bun run db:push        # creates tables in the shipped dev SQLite db
bun run dev            # http://localhost:4000
```

The bundled `.env` is ready for local development (SQLite + dev outboxes).
Every optional integration (Stripe, OAuth, Resend, Twilio) fails CLOSED with
an explicit message until its variables are set — nothing is faked.

## Production (your own host)

1. Provision hosted Postgres (Neon / Supabase / RDS).
2. In `.env` set: `DATABASE_URL` (pooled Postgres), `APP_BASE_URL` (this
   backend's public origin, e.g. https://api.web-agent.org),
   `FRONTEND_BASE_URL` (the Vercel frontend origin), `TRUSTED_ORIGINS`
   (frontend origin + this origin), `AUTH_SECRET` (already generated),
   plus Stripe / Resend / Twilio credentials.
3. Create the schema and seed it:
   ```bash
   DATABASE_URL="postgresql://…" npx prisma db push
   DATABASE_URL="postgresql://…" bun prisma/seed.ts
   ```
4. Build and run (standalone):
   ```bash
   bun run build
   node .next/standalone/server.js   # or: docker build -t taskflow-backend . && docker run …
   ```

## Stripe (required in production — startup refuses without it)

```bash
STRIPE_SECRET_KEY=sk_live_… bun run stripe:setup -- --webhook-url https://<backend-host>/api/webhooks/stripe
```

Creates Pro £30 / Max £90 / credit-pack prices and prints the webhook signing
secret (`whsec_…`). Copy all `STRIPE_*` values into `.env`.

## OAuth callback URLs (register in Google / Entra / GitHub consoles)

```
{APP_BASE_URL}/api/auth/callback/google
{APP_BASE_URL}/api/auth/callback/microsoft-entra-id
{APP_BASE_URL}/api/auth/callback/github
```

## Cross-origin session notes

- Frontend and backend on subdomains of ONE registrable domain (e.g.
  taskflow.web-agent.org + api.web-agent.org): same-site — default
  SameSite=Lax cookie works. Optionally set `SESSION_COOKIE_DOMAIN=.web-agent.org`.
- Frontend on a DIFFERENT site (e.g. *.vercel.app): set
  `SESSION_COOKIE_SAMESITE=none` (secure cookies are automatic in production).

## Tests

```bash
bun test tests/       # identity, tenancy, billing suites
```
