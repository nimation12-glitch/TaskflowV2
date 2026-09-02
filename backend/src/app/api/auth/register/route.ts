/**
 * POST /api/auth/register — email/password registration
 * (correction spec §2, §4, §17).
 *
 * NEW FLOW — verification-first:
 *   create UNVERIFIED account (status PENDING, normalized unique email)
 *   → collect + store the phone number (E.164, unverified)
 *   → send the email-verification challenge
 *   → the user verifies EMAIL, then verifies the PHONE (SMS code)
 *   → activation provisions the workspace (org + OWNER + Free sub +
 *     credits) transactionally — the organization is never fully active
 *     before the verification policy is satisfied (§17).
 *
 * No organization is created here anymore; /api/auth/me returns the pending
 * state so the SPA routes into the verification screens.
 *
 * Hardening: rate-limited (§19), same-origin, password policy, uniform
 * duplicate-email 409 (verified-email uniqueness is the DB UNIQUE on the
 * normalized address, §4), truthful email-transport reporting (§12).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, validatePasswordStrength } from "@/server/auth/password";
import { createSession, purgeExpiredSessions, setSessionCookie } from "@/server/auth/session";
import { issueEmailVerificationToken } from "@/server/auth/tokens";
import { normalizePhone, maskPhone } from "@/server/auth/phone";
import { appLink, emailTemplates, sendEmail } from "@/server/email";
import { smsTransportStatus } from "@/server/sms";
import { recordAudit } from "@/server/audit";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";
import { assertSameOrigin } from "@/server/tenancy/authz";

const schema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(80).optional(),
  password: z.string().min(8).max(128),
  // Anti-abuse control (§3): collected at signup, verified via SMS before
  // the account activates.
  phone: z.string().min(6).max(24),
});

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const ip = clientIp(req);
  const rl = checkAuthRateLimit(`register:${ip}`, AUTH_LIMITS.register.limit, AUTH_LIMITS.register.windowMs);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first ? `${first.path.join(".")}: ${first.message}` : "Invalid input" },
      { status: 400 },
    );
  }
  const { email, name, password } = parsed.data;

  const strength = validatePasswordStrength(password);
  if (strength) return NextResponse.json({ error: strength }, { status: 400 });

  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    return NextResponse.json(
      { error: "Enter a valid phone number in international format, e.g. +44 7700 900123" },
      { status: 400 },
    );
  }

  const normalizedEmail = email.toLowerCase();
  const existing = await db.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    // Uniform duplicate response — the normalized UNIQUE constraint is the
    // authoritative guard (verified-email uniqueness, §4).
    return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
  }

  // Unverified account — PENDING until email + phone verification complete.
  const user = await db.user.create({
    data: {
      email: normalizedEmail,
      name: name ?? normalizedEmail.split("@")[0],
      phone,
      status: "PENDING",
      lastLoginAt: new Date(),
      passwordCredential: { create: { passwordHash: hashPassword(password) } },
    },
  });
  await recordAudit({
    action: "signup",
    userId: user.id,
    metadata: { method: "password", phone: maskPhone(phone), status: "PENDING" },
    ipAddress: ip,
  });

  let emailSent = true;
  let emailError: string | undefined;
  try {
    const raw = await issueEmailVerificationToken(user.id);
    const link = appLink("/verify-email", raw);
    const result = await sendEmail({ to: user.email, ...emailTemplates.verifyEmail(link) });
    emailSent = result.ok;
    if (!result.ok) emailError = result.error;
    await recordAudit({ action: "email_verification_sent", userId: user.id, ipAddress: ip });
  } catch (err) {
    emailSent = false;
    emailError = err instanceof Error ? err.message : "email transport failure";
    console.warn(`[register] verification email failed for ${user.id}: ${emailError}`);
  }

  purgeExpiredSessions().catch(() => undefined);
  const session = await createSession(user.id, { ipAddress: ip, userAgent: req.headers.get("user-agent") });
  const sms = smsTransportStatus();
  const res = NextResponse.json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        emailVerified: false,
      },
      emailVerificationSent: emailSent,
      ...(emailSent ? {} : { emailError }),
      sms: { transport: sms.transport, configured: sms.configured },
      next: "verify_email_then_phone",
    },
    { status: 201 },
  );
  setSessionCookie(res, session.raw, session.expiresAt);
  return res;
}
