/**
 * POST /api/auth/verify-email — consume an EMAIL_VERIFY token (§5, §45).
 * Single-use, expiring, hashed-at-rest (tokens.ts). Audited.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { consumeAuthToken } from "@/server/auth/tokens";
import { recordAudit } from "@/server/audit";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const rl = checkAuthRateLimit(`verify:${ip}`, AUTH_LIMITS.emailVerify.limit, AUTH_LIMITS.emailVerify.windowMs);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let raw: string | undefined;
  try {
    const body = (await req.json()) as { token?: unknown };
    raw = typeof body.token === "string" ? body.token : undefined;
  } catch {
    raw = undefined;
  }
  if (!raw) raw = new URL(req.url).searchParams.get("token") ?? undefined;
  if (!raw) return NextResponse.json({ error: "Verification token is required" }, { status: 400 });

  const result = await consumeAuthToken(raw, "EMAIL_VERIFY");
  if (!result.ok) {
    const message =
      result.reason === "expired"
        ? "This verification link has expired. Request a new one from your account page."
        : result.reason === "used"
          ? "This verification link was already used — your email may already be verified."
          : "This verification link is not valid.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const user = await db.user.update({
    where: { id: result.userId },
    data: { emailVerifiedAt: new Date() },
    select: { email: true, status: true },
  });
  await recordAudit({ action: "email_verified", userId: result.userId, ipAddress: ip });

  // Verification policy re-check: a user whose phone is already verified
  // (or an OAuth-only account) activates + provisions here (correction
  // spec §17). Password accounts still awaiting phone verification remain
  // PENDING until the SMS code is confirmed.
  const { activateUserIfEligible } = await import("@/server/tenancy/activation");
  const activation = await activateUserIfEligible(result.userId, { ip, trigger: "email_verified" });

  return NextResponse.json({
    ok: true,
    email: user.email,
    status: activation.activated ? "ACTIVE" : user.status,
    next: activation.activated ? "dashboard" : "verify_phone",
  });
}
