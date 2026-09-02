# TaskFlow — split deployment (frontend + backend)

```
frontend/   → Vercel (the SPA: landing, auth, dashboard)
backend/    → your own host (API: /api/**, Prisma, Stripe, CORS+CSRF gate)
docs/       → architecture & auth-hardening reports
```

The original single-app workspace remains fully intact; this split is a
generated, verified deploy artifact (both folders typecheck and build
independently; the backend's 84-test suite passes inside its folder).

## What connects the two

| Direction | Variable | Set on | Purpose |
|---|---|---|---|
| frontend → backend | `NEXT_PUBLIC_API_BASE_URL` | frontend (build-time) | every fetch goes to the API origin |
| backend → frontend | `FRONTEND_BASE_URL` | backend | OAuth finishing, email links, checkout returns land on the SPA |
| backend trust | `TRUSTED_ORIGINS` | backend | CORS + CSRF allow-list for the frontend origin |
| cookie scope | `SESSION_COOKIE_DOMAIN` / `SESSION_COOKIE_SAMESITE` | backend | only needed for cross-SITE hosting (e.g. *.vercel.app) |

## Recommended origins

- Frontend: https://taskflow.web-agent.org (Vercel)
- Backend:  https://api.web-agent.org (self-hosted; any host works — set it
  as `APP_BASE_URL`)

Same registrable domain → cookie works with defaults. Cross-site frontend →
set `SESSION_COOKIE_SAMESITE=none` on the backend.

## Quick start

```bash
# backend
cd backend && bun install && bun run db:push && bun run dev    # :4000

# frontend (new terminal)
cd frontend && bun install && bun run dev                      # :3000
```

Then open http://localhost:3000 — email+password auth works immediately
(SMS/email codes land in the dev outboxes served by the backend).
