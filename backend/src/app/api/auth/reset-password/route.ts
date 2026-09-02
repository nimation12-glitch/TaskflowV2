/**
 * POST /api/auth/reset-password — complete a password reset (§5).
 * Consumes the PASSWORD_RESET token, updates the credential, marks the email
 * verified (the token arrived in the inbox of record) and revokes ALL of the
 * user's sessions — a password change invalidates every stolen session (§9).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { validatePasswordStrength, hashPassword } from "@/server/auth/password";
import { consumeAuthToken } from "@/server/auth/tokens";
import { revokeAllUserSessions } from "@/server/auth/session";
import { recordAudit } from "@/server/audit";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";
import { assertSameOrigin } from "@/server/tenancy/authz";

const schema = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8).max(128),
});

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const ip = clientIp(req);
  const rl = checkAuthRateLimit(`reset-complete:${ip}`, 10, 10 * 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "A reset token and a new password are required" }, { status: 400 });
  }

  const strength = validatePasswordStrength(parsed.data.password);
  if (strength) return NextResponse.json({ error: strength }, { status: 400 });

  const result = await consumeAuthToken(parsed.data.token, "PASSWORD_RESET");
  if (!result.ok) {
    const message =
      result.reason === "expired"
        ? "This reset link has expired. Request a new one."
        : result.reason === "used"
          ? "This reset link was already used. Request a new one."
          : "This reset link is not valid.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const user = await db.user.findUnique({ where: { id: result.userId }, include: { passwordCredential: true } });
  if (!user || user.status === "SUSPENDED") {
    // Suspended accounts can never reset. PENDING accounts CAN: the reset
    // token proves email ownership and marks the email verified; activation
    // still enforces the phone policy for password accounts (correction
    // spec §2/§17).
    return NextResponse.json({ error: "Account is not available" }, { status: 403 });
  }

  const passwordHash = hashPassword(parsed.data.password);
  await db.$transaction([
    user.passwordCredential
      ? db.passwordCredential.update({ where: { userId: user.id }, data: { passwordHash } })
      : db.passwordCredential.create({ data: { userId: user.id, passwordHash } }),
    db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: user.emailVerifiedAt ?? new Date() } }),
  ]);
  const revoked = await revokeAllUserSessions(user.id);
  await recordAudit({
    action: "password_reset_completed",
    userId: user.id,
    metadata: { sessionsRevoked: revoked },
    ipAddress: ip,
  });

  return NextResponse.json({ ok: true });
}
