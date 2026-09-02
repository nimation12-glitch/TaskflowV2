/**
 * Split-distribution patch set — TaskFlow frontend/backend separation.
 * Consumed by scripts/split-dist.ts. Every patch's `from` must match EXACTLY
 * once in the target copy, or the generator aborts (fail loud).
 */

export type Patch = { file: string; from: string; to: string };
export type FreshFile = { file: string; content: string };

export const patches: Patch[] = [
  // ── BACKEND ────────────────────────────────────────────────────────────
  {
    // 1. env.ts — frontend base URL + split flag
    file: "src/server/env.ts",
    from: `  get appBaseUrl(): string {
    return env("APP_BASE_URL") ?? env("API_BASE_URL") ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  },`,
    to: `  get appBaseUrl(): string {
    return env("APP_BASE_URL") ?? env("API_BASE_URL") ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  },

  // ── Split deployments (frontend/backend) ───────────────────────────────
  // FRONTEND_BASE_URL names where the SPA is hosted (e.g. Vercel). Every
  // user-facing redirect and emailed link targets it: OAuth finishing,
  // email verification, password reset, invitations, checkout returns.
  // Unset → same-origin deployment (this app serves both UI and API).
  get frontendBaseUrl(): string {
    return env("FRONTEND_BASE_URL") ?? this.appBaseUrl;
  },
  get isSplitDeployment(): boolean {
    return Boolean(env("FRONTEND_BASE_URL"));
  },`,
  },
  {
    // 2. origin.ts — CORS helpers for trusted cross-origin fronts
    file: "src/server/origin.ts",
    from: `import type { NextRequest } from "next/server";
import { serverEnv } from "@/server/env";`,
    to: `import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/server/env";`,
  },
  {
    // 2b. origin.ts — CORS helpers for trusted cross-origin fronts
    file: "src/server/origin.ts",
    from: `export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}`,
    to: `export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

// ── CORS for split deployments ───────────────────────────────────────────
// The Vercel-hosted frontend calls this API cross-origin from the browser.
// Only origins already trusted by isAllowedOrigin ever receive CORS headers
// (same policy as the CSRF gate — one trust list, one source of truth).

const CORS_ALLOW_HEADERS = "Content-Type, X-Auth-Return-Redirect, X-Requested-With";

function sameOrigin(origin: string, req: Pick<NextRequest, "headers">): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Response headers allowing a TRUSTED cross-origin front to call this API.
 *  Null for same-origin requests (nothing to add) and untrusted origins. */
export function corsHeadersFor(origin: string | null, req: Pick<NextRequest, "headers">): Record<string, string> | null {
  if (!origin || !isAllowedOrigin(origin, req) || sameOrigin(origin, req)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

/** Preflight answer for trusted cross-origin fronts (proxy answers OPTIONS
 *  itself — no route handler ever sees a preflight). */
export function preflightResponse(origin: string): Response {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}`,
  },
  {
    // 3. authjs/index.ts — session cookie split overrides
    file: "src/server/auth/authjs/index.ts",
    from: `    sessionToken: {
      name: "tf_session",
      options: {
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        secure: serverEnv.isProduction,
      },
    },`,
    to: `    sessionToken: {
      name: "tf_session",
      options: {
        httpOnly: true,
        // Split deployments with a cross-SITE frontend (e.g. *.vercel.app)
        // set SESSION_COOKIE_SAMESITE=none (+ optional SESSION_COOKIE_DOMAIN
        // for shared parent domains). Same-site subdomain fronts keep Lax.
        sameSite: (process.env.SESSION_COOKIE_SAMESITE === "none" ? "none" : "lax") as "lax" | "none",
        path: "/",
        secure: serverEnv.isProduction || process.env.SESSION_COOKIE_SAMESITE === "none",
        ...(process.env.SESSION_COOKIE_DOMAIN ? { domain: process.env.SESSION_COOKIE_DOMAIN } : {}),
      },
    },`,
  },
  {
    // 4. authjs/index.ts — redirect callback rewrites internal targets onto the frontend
    file: "src/server/auth/authjs/index.ts",
    from: `  callbacks: {
    async signIn(params) {`,
    to: `  callbacks: {
    /**
     * Split deployments: the SPA lives on the frontend origin. Internal
     * targets (Auth.js hash-routed pages, the same-origin /oauth/finish URL
     * the SPA posts as callbackUrl) are rewritten onto FRONTEND_BASE_URL;
     * explicit cross-origin targets pass only when their origin is trusted
     * (never an open redirect). Same-origin deployments are unaffected —
     * every URL already matches the frontend.
     */
    async redirect({ url, baseUrl }) {
      const frontendBase = serverEnv.frontendBaseUrl.replace(/\\/$/, "");
      // OAuth provider authorization endpoints are legitimately cross-origin —
      // they must pass through untouched (never rewritten, never refused).
      const PROVIDER_ORIGINS = new Set([
        "https://accounts.google.com",
        "https://login.microsoftonline.com",
        "https://github.com",
      ]);
      try {
        const target = new URL(url, baseUrl);
        const baseOrigin = new URL(baseUrl).origin;
        if (PROVIDER_ORIGINS.has(target.origin)) return target.toString();
        if (target.origin === baseOrigin) {
          if (target.pathname.startsWith("/oauth/finish")) {
            return frontendBase + "/#/auth/finishing" + target.search;
          }
          return frontendBase + target.pathname + target.search + target.hash;
        }
        const trusted = serverEnv.trustedOrigins.some((t) => {
          try {
            return new URL(t).host === target.host;
          } catch {
            return false;
          }
        });
        return trusted ? target.toString() : frontendBase + "/";
      } catch {
        return frontendBase + "/";
      }
    },
    async signIn(params) {`,
  },
  {
    // 5. [...nextauth] — unconfigured-provider redirect targets the frontend
    file: "src/app/api/auth/[...nextauth]/route.ts",
    from: `  const base = serverEnv.appBaseUrl.replace(/\\/$/, "");
  const url = new URL(\`\${base}/#/auth/finishing\`);
  url.searchParams.set("error", "provider_not_configured");
  url.searchParams.set(
    "message",
    \`\${provider} sign-in is not configured on this deployment. Add \${provider.toUpperCase()}_CLIENT_ID and \${provider.toUpperCase()}_CLIENT_SECRET (see .env.example) and register the callback URL to enable it.\`,
  );`,
    to: `  const base = serverEnv.frontendBaseUrl.replace(/\\/$/, "");
  const url = new URL(\`\${base}/#/auth/finishing\`);
  url.searchParams.set("error", "provider_not_configured");
  url.searchParams.set(
    "message",
    \`\${provider} sign-in is not configured on this deployment. Add \${provider.toUpperCase()}_CLIENT_ID and \${provider.toUpperCase()}_CLIENT_SECRET to the backend environment (see backend/README.md) and register the callback URL to enable it.\`,
  );`,
  },
  {
    // 6. policy.ts — appRedirect targets the frontend (OAuth refusals)
    file: "src/server/auth/authjs/policy.ts",
    from: `  const base = serverEnv.appBaseUrl.replace(/\\/$/, "");
  return \`\${base}/#/auth/finishing?\${query}\`;`,
    to: `  const base = serverEnv.frontendBaseUrl.replace(/\\/$/, "");
  return \`\${base}/#/auth/finishing?\${query}\`;`,
  },
  {
    // 7. email — action links (verify / reset / invite) target the frontend
    file: "src/server/email/index.ts",
    from: `export function appLink(hashPath: string, token: string): string {
  const base = serverEnv.appBaseUrl.replace(/\\/$/, "");
  return \`\${base}/#\${hashPath}?token=\${encodeURIComponent(token)}\`;
}`,
    to: `export function appLink(hashPath: string, token: string): string {
  const base = serverEnv.frontendBaseUrl.replace(/\\/$/, "");
  return \`\${base}/#\${hashPath}?token=\${encodeURIComponent(token)}\`;
}`,
  },
  {
    // 8. checkout — success/cancel land on the frontend's billing view
    file: "src/app/api/billing/checkout/route.ts",
    from: `  const successUrl = \`\${serverEnv.appBaseUrl}/?status=success&session_id={CHECKOUT_SESSION_ID}#/dashboard/billing\`;
  const cancelUrl = \`\${serverEnv.appBaseUrl}/?status=cancelled#/dashboard/billing\`;`,
    to: `  const successUrl = \`\${serverEnv.frontendBaseUrl}/?status=success&session_id={CHECKOUT_SESSION_ID}#/dashboard/billing\`;
  const cancelUrl = \`\${serverEnv.frontendBaseUrl}/?status=cancelled#/dashboard/billing\`;`,
  },
  {
    // 9. instrumentation — wording (no .env.example in the split artifact)
    file: "src/instrumentation.ts",
    from: `      "Refusing to start: production requires AUTH_SECRET (session/OAuth cryptographic secret — see .env.example).",`,
    to: `      "Refusing to start: production requires AUTH_SECRET (session/OAuth cryptographic secret — see backend/README.md).",`,
  },
  {
    file: "src/instrumentation.ts",
    from: `console.warn("[auth] no OAuth providers configured — social sign-in buttons render a truthful disabled state (see .env.example)");`,
    to: `console.warn("[auth] no OAuth providers configured — social sign-in buttons render a truthful disabled state (see backend/README.md)");`,
  },

  // (tests/setup.ts hermeticity — OAuth preload credentials + FRONTEND_BASE_URL
  // deletion — lives in the root tests/setup.ts itself and is copied verbatim.)

  // ── FRONTEND ───────────────────────────────────────────────────────────
  {
    // 10. finishing screen — cross-origin session check
    file: "frontend/src/components/taskflow/auth-screens.tsx",
    from: `        const res = await fetch("/api/auth/me", { credentials: "same-origin" });`,
    to: `        const res = await fetch(apiUrl("/api/auth/me"), { credentials: "include" });`,
  },
  {
    // 11. dev outbox helper — cross-origin reads (dev only)
    file: "frontend/src/components/taskflow/dev-outbox-helper.tsx",
    from: "const filtered = await fetch(`${endpoint}?to=${encodeURIComponent(normalized)}`, { credentials: \"same-origin\" });",
    to: "const filtered = await fetch(apiUrl(`${endpoint}?to=${encodeURIComponent(normalized)}`), { credentials: \"include\" });",
  },
  {
    file: "frontend/src/components/taskflow/dev-outbox-helper.tsx",
    from: `const all = await fetch(endpoint, { credentials: "same-origin" });`,
    to: `const all = await fetch(apiUrl(endpoint), { credentials: "include" });`,
  },
];
