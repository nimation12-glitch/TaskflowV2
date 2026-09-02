/**
 * POST /api/auth/phone/confirm — verify the SMS code (correction spec §3).
 *
 * Single-use, expiring, attempt-limited challenges (phone.ts) + per-user
 * confirmation rate limits (§19). On success: phoneVerifiedAt set with
 * VERIFIED-PHONE UNIQUENESS (§4) and the pending-account activation policy
 * is applied — activation provisions the workspace through the shared
 * transactional path (§9).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveSession } from "@/server/auth/session";
import { consumePhoneChallenge, markPhoneVerified, maskPhone } from "@/server/auth/phone";
import { activateUserIfEligible } from "@/server/tenancy/activation";
import { assertSameOrigin } from "@/server/tenancy/authz";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";
import { recordAudit } from "@/server/audit";

const schema = z.object({
  code: z.string().regex(/^\d{6}$/, "The verification code is 6 digits"),
});

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const resolved = await resolveSession(req);
  if (!resolved) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const ip = clientIp(req);
  const rl = checkAuthRateLimit(`sms:confirm:${resolved.user.id}`, AUTH_LIMITS.smsConfirm.limit, AUTH_LIMITS.smsConfirm.windowMs);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many verification attempts. Try again later." },
      { status: 429, headers: { "Retry-After": "120" } },
    );
  }

  let code: string | undefined;
  try {
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Enter the 6-digit code" }, { status: 400 });
    }
    code = parsed.data.code;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const consumed = await consumePhoneChallenge(resolved.user.id, code);
  if (!consumed.ok) {
    // Uniform, non-revealing messages; "too_many_attempts" is explicit so
    // the user knows to request a fresh code.
    const message =
      consumed.reason === "expired"
        ? "This code has expired. Request a new one."
        : consumed.reason === "too_many_attempts"
          ? "Too many incorrect attempts for this code. Request a new one."
          : consumed.reason === "no_challenge"
            ? "No active verification — request a code first."
            : "That code is not correct.";
    const status = consumed.reason === "no_challenge" ? 400 : 401;
    return NextResponse.json({ error: message }, { status });
  }

  const marked = await markPhoneVerified(resolved.user.id, consumed.phone, { ip });
  if (!marked.ok) {
    await recordAudit({
      action: "phone_verification_refused",
      userId: resolved.user.id,
      metadata: { phone: maskPhone(consumed.phone), reason: "phone_in_use" },
      ipAddress: ip,
    });
    return NextResponse.json(
      { error: "This phone number is already verified on another account." },
      { status: 409 },
    );
  }

  // Activation policy: password accounts become fully active once BOTH the
  // email and the phone are verified; provisioning happens exactly once
  // through the shared transactional path (§9).
  const activation = await activateUserIfEligible(resolved.user.id, { ip, trigger: "phone_verified" });
  const user = await db.user.findUnique({
    where: { id: resolved.user.id },
    select: { status: true, emailVerifiedAt: true },
  });

  return NextResponse.json({
    ok: true,
    phoneVerified: true,
    status: user?.status ?? "PENDING",
    activated: activation.activated,
    next: activation.activated ? "dashboard" : user?.emailVerifiedAt ? null : "verify_email",
  });
}
