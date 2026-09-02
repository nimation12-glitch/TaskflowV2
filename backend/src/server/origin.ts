/**
 * Trusted-origin validation — THE single source of truth for the
 * same-origin CSRF decision (correction spec §7, §14).
 *
 * This module is deliberately dependency-free (serverEnv only) so it can
 * run in the Edge runtime (src/proxy.ts) AND in the Node.js runtime
 * (tenancy/authz.ts defence-in-depth layer).
 *
 * A mutating request's Origin is accepted when ANY of:
 *   - the request's own Host (same-origin through any fronting proxy), or
 *   - APP_BASE_URL  (the canonical origin of this deployment), or
 *   - an explicit TRUSTED_ORIGINS entry (multi-environment deployments:
 *     http://localhost:3000 + the sandbox preview front in development,
 *     https://taskflow.web-agent.org in production).
 * Arbitrary hosts are NEVER trusted. An absent Origin is allowed (same-
 * origin navigations and server-to-server calls such as Stripe webhooks);
 * cross-site browser requests always carry an Origin header.
 */
import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/server/env";

export function isAllowedOrigin(origin: string | null, req: Pick<NextRequest, "headers">): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = req.headers.get("host");
  if (host && originHost === host) return true;
  for (const base of serverEnv.trustedOrigins) {
    try {
      if (originHost === new URL(base).host) return true;
    } catch {
      // malformed entry — ignore it, never crash the gate
    }
  }
  return false;
}

/** HTTP methods that can change state and therefore require the origin check. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
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
}
