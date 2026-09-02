/**
 * POST /api/auth/phone/request — request an SMS verification code
 * (correction spec §3, §13).
 *
 * Rate limits: per-user 3/10min + per-IP 10/10min (§19). The response is
 * TRUTHFUL about delivery: `smsAccepted=false` + reason when the provider
 * is not configured or the send fails — never a fake "code sent" (§12).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveSession } from "@/server/auth/session";
import { issuePhoneChallenge } from "@/server/auth/phone";
import { assertSameOrigin } from "@/server/tenancy/authz";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";

const schema = z.object({
  // Omitted → re-use the stored phone; provided → set/replace the number
  // (the new number stays unverified until the code is confirmed).
  phone: z.string().min(6).max(24).optional(),
});

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const resolved = await resolveSession(req);
  if (!resolved) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const ip = clientIp(req);
  const rlUser = checkAuthRateLimit(`sms:req:user:${resolved.user.id}`, AUTH_LIMITS.smsRequest.limit, AUTH_LIMITS.smsRequest.windowMs);
  const rlIp = checkAuthRateLimit(`sms:req:ip:${ip}`, AUTH_LIMITS.smsRequestIp.limit, AUTH_LIMITS.smsRequestIp.windowMs);
  if (!rlUser.allowed || !rlIp.allowed) {
    return NextResponse.json(
      { error: "Too many verification codes requested. Try again later." },
      { status: 429, headers: { "Retry-After": "120" } },
    );
  }

  let phone: string | undefined;
  try {
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "phone must be a valid number" }, { status: 400 });
    }
    phone = parsed.data.phone;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const target = phone ?? resolved.user.phone;
  if (!target) {
    return NextResponse.json({ error: "A phone number is required" }, { status: 400 });
  }

  const result = await issuePhoneChallenge(resolved.user.id, target, { ip });
  if (!result.ok) {
    if (result.reason === "invalid_phone") {
      return NextResponse.json(
        { error: "Enter a valid phone number in international format, e.g. +44 7700 900123" },
        { status: 400 },
      );
    }
    // Fail closed, truthfully (§12/§16): no code was sent — the UI shows a
    // configuration state instead of pretending otherwise.
    return NextResponse.json(
      {
        sent: false,
        reason: "sms_not_configured",
        error: "SMS delivery is not configured on this deployment. Set SMS_PROVIDER and its credentials (see .env.example).",
      },
      { status: 503 },
    );
  }

  // Persist the (unverified) number when a new one was supplied.
  if (phone && phone !== resolved.user.phone) {
    await db.user.update({
      where: { id: resolved.user.id },
      data: { phone: result.phone, phoneVerifiedAt: null },
    });
  }

  return NextResponse.json({
    sent: true,
    smsAccepted: result.smsAccepted,
    transport: result.transport,
    ...(result.smsAccepted ? {} : { error: result.smsError }),
  });
}
