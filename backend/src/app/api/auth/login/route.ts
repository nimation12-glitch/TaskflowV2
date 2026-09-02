/**
 * POST /api/auth/login — email/password sign-in through Auth.js
 * (correction spec §1, §5, §8).
 *
 * The Credentials PROVIDER lives in the Auth.js configuration; this route
 * drives it through the framework's Auth() entry (raw + skipCSRFCheck —
 * exactly the pattern next-auth's own server actions use), then converts
 * the framework's decision into a TaskFlow DATABASE session (§8).
 *
 * Why not the browser-facing /api/auth/callback/credentials? Auth.js v5's
 * credentials flow is JWT-only by design (documented limitation) while
 * TaskFlow's security architecture requires database-backed sessions with
 * revocation (§8). Driving Auth() server-side keeps ALL verification logic
 * in the framework's authorize() hook and produces one session mechanism —
 * no JWT cookies, no parallel session stores.
 *
 * Hardening (unchanged): rate-limited per IP and per IP+email (§19),
 * uniform failure response (no account enumeration, §33 old spec),
 * session-fixation safe (fresh token every login), audited, suspended
 * users rejected, PENDING users allowed (they must finish verification).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, CredentialsSignin } from "@auth/core/errors";
import { Auth, raw, skipCSRFCheck } from "@auth/core";
import { authConfig } from "@/server/auth/authjs";
import { createSession, purgeExpiredSessions, setSessionCookie } from "@/server/auth/session";
import { ensureCurrentPeriod } from "@/server/billing/subscription";
import { checkLoginRateLimits, clientIp } from "@/server/auth/rate-limit";
import { assertSameOrigin } from "@/server/tenancy/authz";
import { runWithAuthContext, getAuthContext } from "@/server/auth/auth-context";
import { db } from "@/lib/db";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const ip = clientIp(req);

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();

  const rl = checkLoginRateLimits(ip, email);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  // Drive the Auth.js Credentials provider with the request-scoped context
  // (IP/UA land on the session row; authorize() stashes the result).
  const internalReq = new Request("http://localhost/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: parsed.data.email, password: parsed.data.password }),
  });

  const outcome = await runWithAuthContext({ ipAddress: ip, userAgent: req.headers.get("user-agent") }, async () => {
    try {
      await Auth(internalReq, {
        ...authConfig,
        // Auth.js' credentials branch is JWT-only (assert.ts refuses
        // credentials with the database strategy when no OAuth provider is
        // configured). This is an INTERNAL call: the framework's JWT cookie
        // is discarded below — the durable session is the TaskFlow database
        // session created here (§8). Nothing JWT-based reaches the browser.
        session: { ...authConfig.session, strategy: "jwt" as const },
        raw,
        skipCSRFCheck,
      });
    } catch (err) {
      return { ok: false as const, error: err, userId: null };
    }
    // Read the stash INSIDE the request scope (AsyncLocalStorage ends with
    // this callback).
    return { ok: true as const, error: null, userId: getAuthContext().credentialsResult?.userId ?? null };
  });

  if (!outcome.ok) {
    const err = outcome.error;
    if (err instanceof CredentialsSignin || (err instanceof AuthError && err.name === "CredentialsSignin")) {
      // Uniform response — no enumeration (§33 old spec).
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }
    console.error(`[login] auth.js failure: ${err instanceof Error ? err.message : err}`);
    return NextResponse.json({ error: "Sign-in failed. Please try again." }, { status: 500 });
  }

  const userId = outcome.userId;
  if (!userId) {
    // authorize() succeeded without stashing a result — defensive.
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  // Trigger lazy rollover (grants monthly credits if the period elapsed).
  const membership = await db.membership.findFirst({
    where: { userId: user.id },
    include: { organization: { include: { subscription: true } } },
    take: 1,
  });
  const subscriptionId = membership?.organization.subscription?.id;
  if (subscriptionId) {
    await ensureCurrentPeriod(subscriptionId).catch(() => undefined);
  }

  purgeExpiredSessions().catch(() => undefined);
  const session = await createSession(user.id, { ipAddress: ip, userAgent: req.headers.get("user-agent") });
  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name, status: user.status },
  });
  setSessionCookie(res, session.raw, session.expiresAt);
  return res;
}
