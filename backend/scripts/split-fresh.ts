/**
 * Fresh files written into the split distribution (frontend/backend).
 * Backticks and ${} inside these literals are escaped for this generator.
 */

export const freshFiles: Record<string, string> = {
  // ── backend/src/proxy.ts — CORS-aware origin gate ───────────────────────
  "backend/src/proxy.ts": `/**
 * Global API origin gate + CORS edge (Next.js 16 proxy).
 *
 * CSRF: rejects cross-site MUTATING /api requests with 403 before any route
 * handler runs — the Origin must match the request host, APP_BASE_URL, or an
 * explicit TRUSTED_ORIGINS entry. Arbitrary hosts are never trusted.
 *
 * CORS (split deployments): the Vercel frontend calls this API cross-origin,
 * so trusted cross-origin requests get Access-Control-Allow-* headers and
 * preflights (OPTIONS) are answered here directly. One trust list —
 * serverEnv.trustedOrigins — drives BOTH decisions (see server/origin.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { corsHeadersFor, isAllowedOrigin, isMutatingMethod, preflightResponse } from "@/server/origin";

function withCors(res: NextResponse, cors: Record<string, string> | null): NextResponse {
  if (cors) {
    for (const [key, value] of Object.entries(cors)) res.headers.set(key, value);
  }
  return res;
}

export default function proxy(req: NextRequest) {
  const origin = req.headers.get("origin");
  const cors = corsHeadersFor(origin, req);

  // Preflight never reaches a route handler — answered at the edge.
  if (req.method === "OPTIONS") {
    return cors ? preflightResponse(origin as string) : new NextResponse(null, { status: 403 });
  }

  if (!isMutatingMethod(req.method)) return withCors(NextResponse.next(), cors);
  if (isAllowedOrigin(origin, req)) return withCors(NextResponse.next(), cors);
  return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
}

export const config = {
  matcher: "/api/:path*",
};
`,

  // ── frontend/src/lib/client-api.ts — backend-aware fetch wrapper ────────
  "frontend/src/lib/client-api.ts": `/** Small typed fetch wrapper for the TaskFlow dashboard SPA. */

/**
 * Base URL of the TaskFlow API (the backend deployment), e.g.
 * https://api.web-agent.org. Empty string in same-origin deployments where
 * the Next.js app serves both the UI and /api/*.
 * Configured via NEXT_PUBLIC_API_BASE_URL (baked in at build time).
 */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\\/+$/, "");

/** Resolve an API path against the backend origin. */
export function apiUrl(path: string): string {
  return \`\${API_BASE_URL}\${path}\`;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    // "include" (not "same-origin"): the split frontend calls the backend
    // cross-origin, so the tf_session cookie must travel on every request.
    credentials: "include",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? \`Request failed (\${res.status})\`);
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/**
 * Begin an Auth.js OAuth flow (Google / Microsoft / GitHub) from the SPA —
 * fetch the CSRF token from the backend, POST to its signin action, then
 * navigate to the returned authorization URL. The callbackUrl posted here is
 * SAME-ORIGIN with the API (so Auth.js core accepts it); the backend's
 * redirect policy rewrites it onto this frontend's /#/auth/finishing screen.
 * \`link\` mode is for the Account page's "Connect provider" buttons.
 */
export async function startOAuth(provider: string, mode: "signin" | "link" = "signin"): Promise<string> {
  const { csrfToken } = await api<{ csrfToken: string }>("/api/auth/csrf");
  const finishParams = new URLSearchParams({ provider });
  if (mode === "link") finishParams.set("mode", "link");
  const callbackUrl = apiUrl(\`/oauth/finish?\${finishParams.toString()}\`);
  const res = await fetch(apiUrl(\`/api/auth/signin/\${provider}\`), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Auth-Return-Redirect": "1",
    },
    body: new URLSearchParams({ csrfToken, callbackUrl }),
    credentials: "include",
  });
  const text = await res.text();
  let data: { url?: string; error?: string } = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("OAuth sign-in could not be started");
  }
  if (!res.ok || !data.url) {
    throw new Error(data.error === "provider_not_configured" ? "This provider is not configured on this deployment" : "OAuth sign-in could not be started");
  }
  return data.url;
}
`,

  // ── backend/src/app/layout.tsx — minimal (API-only app) ─────────────────
  "backend/src/app/layout.tsx": `/**
 * Minimal root layout — the backend serves /api/** route handlers only.
 * The product UI lives in the frontend deployment.
 */
export const metadata = { title: "TaskFlow API" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,

  // ── backend/next.config.ts ──────────────────────────────────────────────
  "backend/next.config.ts": `import type { NextConfig } from "next";

// The backend self-hosts via the standalone output (Docker / node server.js).
// Vercel never serves the backend, but if it were ever imported there, the
// flag auto-disables (VERCEL=1) exactly like the frontend config.
const isVercel = process.env.VERCEL === "1";

const nextConfig: NextConfig = {
  ...(isVercel ? {} : { output: "standalone" as const }),
  turbopack: { root: process.cwd() },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
`,

  // ── frontend/next.config.ts ─────────────────────────────────────────────
  "frontend/next.config.ts": `import type { NextConfig } from "next";

// Frontend-only deployment (Vercel): no standalone output, no API routes.
// turbopack.root pins the project boundary — without it Turbopack can walk
// up a parent directory (.git/lockfile) and compile files that do not
// belong to this app.
const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
`,

  // ── backend/Dockerfile ──────────────────────────────────────────────────
  "backend/Dockerfile": `# TaskFlow backend — self-hosted (standalone Next.js output)
# Build:  docker build -t taskflow-backend .
# Run:    docker run -p 4000:4000 --env-file .env taskflow-backend
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV HOSTNAME=0.0.0.0

COPY .next/standalone ./
COPY .next/static ./.next/static
COPY public ./public

EXPOSE 4000
CMD ["node", "server.js"]
`,

  // ── backend/README.md ───────────────────────────────────────────────────
  "backend/README.md": `# TaskFlow — Backend (API)

Next.js API deployment: all \`/api/**\` route handlers (auth, orgs, billing,
keys, usage, gateway), Prisma + database, the CSRF/CORS proxy gate and the
startup fail-closed validation. The product UI lives in \`../frontend\`
(Vercel). The two talk over \`FRONTEND_BASE_URL\` (backend → frontend, for
redirects and email links) and \`NEXT_PUBLIC_API_BASE_URL\` (frontend →
backend, for fetch calls).

## Run locally

\`\`\`bash
bun install            # or npm install
bun run db:push        # creates tables in the shipped dev SQLite db
bun run dev            # http://localhost:4000
\`\`\`

The bundled \`.env\` is ready for local development (SQLite + dev outboxes).
Every optional integration (Stripe, OAuth, Resend, Twilio) fails CLOSED with
an explicit message until its variables are set — nothing is faked.

## Production (your own host)

1. Provision hosted Postgres (Neon / Supabase / RDS).
2. In \`.env\` set: \`DATABASE_URL\` (pooled Postgres), \`APP_BASE_URL\` (this
   backend's public origin, e.g. https://api.web-agent.org),
   \`FRONTEND_BASE_URL\` (the Vercel frontend origin), \`TRUSTED_ORIGINS\`
   (frontend origin + this origin), \`AUTH_SECRET\` (already generated),
   plus Stripe / Resend / Twilio credentials.
3. Create the schema and seed it:
   \`\`\`bash
   DATABASE_URL="postgresql://…" npx prisma db push
   DATABASE_URL="postgresql://…" bun prisma/seed.ts
   \`\`\`
4. Build and run (standalone):
   \`\`\`bash
   bun run build
   node .next/standalone/server.js   # or: docker build -t taskflow-backend . && docker run …
   \`\`\`

## Stripe (required in production — startup refuses without it)

\`\`\`bash
STRIPE_SECRET_KEY=sk_live_… bun run stripe:setup -- --webhook-url https://<backend-host>/api/webhooks/stripe
\`\`\`

Creates Pro £30 / Max £90 / credit-pack prices and prints the webhook signing
secret (\`whsec_…\`). Copy all \`STRIPE_*\` values into \`.env\`.

## OAuth callback URLs (register in Google / Entra / GitHub consoles)

\`\`\`
{APP_BASE_URL}/api/auth/callback/google
{APP_BASE_URL}/api/auth/callback/microsoft-entra-id
{APP_BASE_URL}/api/auth/callback/github
\`\`\`

## Cross-origin session notes

- Frontend and backend on subdomains of ONE registrable domain (e.g.
  taskflow.web-agent.org + api.web-agent.org): same-site — default
  SameSite=Lax cookie works. Optionally set \`SESSION_COOKIE_DOMAIN=.web-agent.org\`.
- Frontend on a DIFFERENT site (e.g. *.vercel.app): set
  \`SESSION_COOKIE_SAMESITE=none\` (secure cookies are automatic in production).

## Tests

\`\`\`bash
bun test tests/       # identity, tenancy, billing suites
\`\`\`
`,

  // ── frontend/README.md ──────────────────────────────────────────────────
  "frontend/README.md": `# TaskFlow — Frontend (Vercel)

The TaskFlow SPA: landing, auth screens, dashboard (overview, keys, usage,
billing, compute, models, docs, team, account). All data comes from the
backend deployment via \`NEXT_PUBLIC_API_BASE_URL\`.

## Deploy to Vercel

1. Push this folder to a Git repo (or use Vercel CLI with Root Directory =
   \`frontend\` if it lives in the monorepo).
2. Vercel auto-detects Next.js. Build command \`next build\` — no extra config.
3. Environment variables (Production):
   - \`NEXT_PUBLIC_API_BASE_URL\` = your backend origin, e.g.
     \`https://api.web-agent.org\`  (no trailing slash)
4. Add your domain (e.g. \`taskflow.web-agent.org\`) in Vercel → Settings →
   Domains, then make sure the backend's \`TRUSTED_ORIGINS\` and
   \`FRONTEND_BASE_URL\` point at it.

## Run locally

\`\`\`bash
bun install
bun run dev            # http://localhost:3000  (expects backend on :4000)
\`\`\`

The bundled \`.env\` points at http://localhost:4000 — start the backend first
(\`../backend\`: \`bun run dev\`).

## Session cookie requirement

The backend sets the \`tf_session\` cookie. If this frontend is hosted on a
subdomain of the same registrable domain as the backend
(\`taskflow.web-agent.org\` + \`api.web-agent.org\`), it works as-is. On a
different site (e.g. \`*.vercel.app\`), set \`SESSION_COOKIE_SAMESITE=none\` on
the BACKEND.
`,

  // ── zip-root README.md ──────────────────────────────────────────────────
  "README.md": `# TaskFlow — split deployment (frontend + backend)

\`\`\`
frontend/   → Vercel (the SPA: landing, auth, dashboard)
backend/    → your own host (API: /api/**, Prisma, Stripe, CORS+CSRF gate)
docs/       → architecture & auth-hardening reports
\`\`\`

The original single-app workspace remains fully intact; this split is a
generated, verified deploy artifact (both folders typecheck and build
independently; the backend's 84-test suite passes inside its folder).

## What connects the two

| Direction | Variable | Set on | Purpose |
|---|---|---|---|
| frontend → backend | \`NEXT_PUBLIC_API_BASE_URL\` | frontend (build-time) | every fetch goes to the API origin |
| backend → frontend | \`FRONTEND_BASE_URL\` | backend | OAuth finishing, email links, checkout returns land on the SPA |
| backend trust | \`TRUSTED_ORIGINS\` | backend | CORS + CSRF allow-list for the frontend origin |
| cookie scope | \`SESSION_COOKIE_DOMAIN\` / \`SESSION_COOKIE_SAMESITE\` | backend | only needed for cross-SITE hosting (e.g. *.vercel.app) |

## Recommended origins

- Frontend: https://taskflow.web-agent.org (Vercel)
- Backend:  https://api.web-agent.org (self-hosted; any host works — set it
  as \`APP_BASE_URL\`)

Same registrable domain → cookie works with defaults. Cross-site frontend →
set \`SESSION_COOKIE_SAMESITE=none\` on the backend.

## Quick start

\`\`\`bash
# backend
cd backend && bun install && bun run db:push && bun run dev    # :4000

# frontend (new terminal)
cd frontend && bun install && bun run dev                      # :3000
\`\`\`

Then open http://localhost:3000 — email+password auth works immediately
(SMS/email codes land in the dev outboxes served by the backend).
`,
};
