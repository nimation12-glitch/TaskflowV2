/**
 * POST /api/auth/forgot-password — request a password reset (§5, §33).
 *
 * ALWAYS responds 200 with a generic message — the response never reveals
 * whether the email exists (no account enumeration). Real emails are sent
 * only to registered addresses. Rate-limited per IP and per email.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { issuePasswordResetToken } from "@/server/auth/tokens";
import { appLink, emailTemplates, sendEmail } from "@/server/email";
import { recordAudit } from "@/server/audit";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";
import { assertSameOrigin } from "@/server/tenancy/authz";

const schema = z.object({ email: z.string().email().max(254) });

const GENERIC_RESPONSE = {
  ok: true,
  message: "If an account exists for that address, a password reset link has been sent.",
};

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const ip = clientIp(req);

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json(GENERIC_RESPONSE);

  const email = parsed.data.email.toLowerCase();
  const rlIp = checkAuthRateLimit(`reset:ip:${ip}`, AUTH_LIMITS.passwordReset.limit, AUTH_LIMITS.passwordReset.windowMs);
  const rlEmail = checkAuthRateLimit(`reset:email:${ip}:${email}`, AUTH_LIMITS.passwordResetEmail.limit, AUTH_LIMITS.passwordResetEmail.windowMs);
  if (!rlIp.allowed || !rlEmail.allowed) {
    // Same generic shape — rate-limit responses must not be an enumeration oracle.
    return NextResponse.json(GENERIC_RESPONSE);
  }

  const user = await db.user.findUnique({ where: { email } });
  // PENDING accounts are included: a reset link IS email-ownership proof and
  // doubles as their recovery path (the reset marks the email verified;
  // phone verification is still enforced by the activation policy).
  // SUSPENDED accounts get nothing.
  if (user && user.status !== "SUSPENDED") {
    const raw = await issuePasswordResetToken(user.id);
    const link = appLink("/reset-password", raw);
    await sendEmail({ to: user.email, ...emailTemplates.passwordReset(link) });
    await recordAudit({ action: "password_reset_requested", userId: user.id, ipAddress: ip });
  }

  return NextResponse.json(GENERIC_RESPONSE);
}
