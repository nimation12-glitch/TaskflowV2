/**
 * POST /api/auth/password/change — change password while signed in (§28).
 * Requires the CURRENT password (no session hijack → password takeover),
 * then revokes all OTHER sessions (the current device stays signed in).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/server/auth/password";
import { resolveSession, revokeAllUserSessions } from "@/server/auth/session";
import { recordAudit } from "@/server/audit";
import { checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";
import { assertSameOrigin } from "@/server/tenancy/authz";

const schema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const resolved = await resolveSession(req);
  if (!resolved) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { user, session } = resolved;

  const ip = clientIp(req);
  const rl = checkAuthRateLimit(`pw-change:${ip}:${user.id}`, 5, 10 * 60_000);
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
    return NextResponse.json({ error: "Current and new passwords are required" }, { status: 400 });
  }

  const credential = await db.passwordCredential.findUnique({ where: { userId: user.id } });
  if (!credential) {
    return NextResponse.json(
      { error: "This account uses a social login. Set a password via the password-reset flow." },
      { status: 409 },
    );
  }
  if (!verifyPassword(parsed.data.currentPassword, credential.passwordHash)) {
    await recordAudit({ action: "login_failed", userId: user.id, metadata: { context: "password_change" }, ipAddress: ip });
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 403 });
  }
  const strength = validatePasswordStrength(parsed.data.newPassword);
  if (strength) return NextResponse.json({ error: strength }, { status: 400 });

  await db.passwordCredential.update({
    where: { userId: user.id },
    data: { passwordHash: hashPassword(parsed.data.newPassword) },
  });
  // Rotate: every OTHER session dies; the current one survives so the user
  // is not logged out of the device they are holding.
  await db.session.updateMany({
    where: { userId: user.id, revokedAt: null, id: { not: session.id } },
    data: { revokedAt: new Date() },
  });
  await recordAudit({ action: "password_change", userId: user.id, ipAddress: ip });

  return NextResponse.json({ ok: true });
}
