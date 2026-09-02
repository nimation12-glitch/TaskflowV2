# TaskFlow — Frontend (Vercel)

The TaskFlow SPA: landing, auth screens, dashboard (overview, keys, usage,
billing, compute, models, docs, team, account). All data comes from the
backend deployment via `NEXT_PUBLIC_API_BASE_URL`.

## Deploy to Vercel

1. Push this folder to a Git repo (or use Vercel CLI with Root Directory =
   `frontend` if it lives in the monorepo).
2. Vercel auto-detects Next.js. Build command `next build` — no extra config.
3. Environment variables (Production):
   - `NEXT_PUBLIC_API_BASE_URL` = your backend origin, e.g.
     `https://api.web-agent.org`  (no trailing slash)
4. Add your domain (e.g. `taskflow.web-agent.org`) in Vercel → Settings →
   Domains, then make sure the backend's `TRUSTED_ORIGINS` and
   `FRONTEND_BASE_URL` point at it.

## Run locally

```bash
bun install
bun run dev            # http://localhost:3000  (expects backend on :4000)
```

The bundled `.env` points at http://localhost:4000 — start the backend first
(`../backend`: `bun run dev`).

## Session cookie requirement

The backend sets the `tf_session` cookie. If this frontend is hosted on a
subdomain of the same registrable domain as the backend
(`taskflow.web-agent.org` + `api.web-agent.org`), it works as-is. On a
different site (e.g. `*.vercel.app`), set `SESSION_COOKIE_SAMESITE=none` on
the BACKEND.
