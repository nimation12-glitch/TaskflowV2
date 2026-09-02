/**
 * POST /api/auth/resend-verification — re-issue the email verification link
 * for the signed-in user (§28 account page). Rate-limited; uniform response
 * regardless of current verification state.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveSession } from "@/server/auth/session";
import { issueEmailVerificationToken } from "@/server/auth/tokens";
import { appLink, emailTemplates, sendEmail } from "@/server/email";
import { recordAudit } from "@/server/audit";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";
import { assertSameOrigin } from "@/server/tenancy/authz";

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const resolved = await resolveSession(req);
  if (!resolved) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const ip = clientIp(req);
  const rl = checkAuthRateLimit(`verify-resend:${ip}`, AUTH_LIMITS.emailVerify.limit, AUTH_LIMITS.emailVerify.windowMs);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }

  if (resolved.user.emailVerifiedAt) {
    return NextResponse.json({ ok: true, alreadyVerified: true });
  }

  const raw = await issueEmailVerificationToken(resolved.user.id);
  const link = appLink("/verify-email", raw);
  const result = await sendEmail({ to: resolved.user.email, ...emailTemplates.verifyEmail(link) });
  await recordAudit({ action: "email_verification_sent", userId: resolved.user.id, ipAddress: ip });

  return NextResponse.json({ ok: true, sent: result.ok });
}
