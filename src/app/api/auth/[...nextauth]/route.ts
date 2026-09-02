/**
 * /api/auth/[...nextauth] — Auth.js protocol routes (correction spec §1).
 *
 * Handles: GET  /api/auth/csrf | /session | /signin/:provider (page)
 *          POST /api/auth/signin/:provider   (OAuth initiation)
 *          GET  /api/auth/callback/:provider (OAuth callback)
 *          POST /api/auth/callback/:provider (credentials callback)
 *          POST /api/auth/signout
 *
 * The wrapper pins request-scoped metadata (IP/UA capture on session rows,
 * existing-session detection for the linking policy) around the framework
 * call, and rate-limits the sensitive actions (§19). Providers without
 * credentials never reach the framework — sign-in initiation refuses with
 * an explicit configuration error (no fake flows, §4/§16/§46).
 *
 * Auth.js derives the action from the request URL itself (NextRequest.nextUrl),
 * so no route params are needed here — static sibling routes (login,
 * register, me, phone/*, …) take precedence over this catch-all as usual.
 */
import { NextRequest, NextResponse } from "next/server";
import { handlers } from "@/server/auth/authjs";
import { runWithAuthContext } from "@/server/auth/auth-context";
import { resolveSession } from "@/server/auth/session";
import { checkLoginRateLimits, AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";
import { serverEnv } from "@/server/env";
import { isOAuthProvider, isProviderConfigured } from "@/server/auth/authjs/provider-map";

function tooMany(): NextResponse {
  return NextResponse.json(
    { error: "Too many authentication attempts. Try again later." },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}

/** Configuration error redirect into the SPA (same shape as policy.ts). */
function providerNotConfiguredRedirect(provider: string): NextResponse {
  const base = serverEnv.appBaseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/#/auth/finishing`);
  url.searchParams.set("error", "provider_not_configured");
  url.searchParams.set(
    "message",
    `${provider} sign-in is not configured on this deployment. Add ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET (see .env.example) and register the callback URL to enable it.`,
  );
  return NextResponse.redirect(url.toString());
}

/** Path segments after /api/auth: ["callback", "google"], ["signin", "github"], … */
function authPath(req: NextRequest): string[] {
  const { pathname } = req.nextUrl;
  return pathname.replace(/^\/api\/auth\/?/, "").split("/").filter(Boolean);
}

export async function GET(req: NextRequest) {
  const [action, provider] = authPath(req);
  const ip = clientIp(req);

  // OAuth callback: rate-limit per IP (callback floods, §19).
  if (action === "callback" && provider && provider !== "credentials") {
    const rl = checkAuthRateLimit(`oauth:${ip}`, AUTH_LIMITS.oauthStart.limit, AUTH_LIMITS.oauthStart.windowMs);
    if (!rl.allowed) return tooMany();
  }

  return runWithAuthContext(
    {
      ipAddress: ip,
      userAgent: req.headers.get("user-agent"),
      sessionUserId: (await resolveSession(req))?.user.id ?? null,
    },
    () => handlers.GET(req),
  );
}

export async function POST(req: NextRequest) {
  const [action, provider] = authPath(req);
  const ip = clientIp(req);

  // OAuth initiation: rate-limit per IP (§19) + explicit unconfigured state.
  if (action === "signin" && provider) {
    const rl = checkAuthRateLimit(`oauth:${ip}`, AUTH_LIMITS.oauthStart.limit, AUTH_LIMITS.oauthStart.windowMs);
    if (!rl.allowed) return tooMany();
    if (isOAuthProvider(provider) && !isProviderConfigured(provider)) {
      return providerNotConfiguredRedirect(provider);
    }
  }

  // Credentials posts through the framework path get the SAME login rate
  // limits as /api/auth/login — one sliding window, no bypass (§19).
  if (action === "callback" && provider === "credentials") {
    let email = "";
    try {
      const form = await req.formData();
      email = String(form.get("email") ?? "").trim().toLowerCase();
    } catch {
      return NextResponse.json({ error: "Invalid credentials body" }, { status: 400 });
    }
    const rl = checkLoginRateLimits(ip, email);
    if (!rl.allowed) return tooMany();
  }

  return runWithAuthContext(
    {
      ipAddress: ip,
      userAgent: req.headers.get("user-agent"),
      sessionUserId: (await resolveSession(req))?.user.id ?? null,
    },
    () => handlers.POST(req),
  );
}
