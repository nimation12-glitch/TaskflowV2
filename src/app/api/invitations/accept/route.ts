/**
 * POST /api/invitations/accept — accept an invitation (§21).
 * Requires a signed-in user whose account controls the invited email.
 * The invitation itself authorizes joining — typing the same email is never
 * enough; the single-use token + email ownership is the proof.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveSession } from "@/server/auth/session";
import { acceptInvitation, invitationErrorResponse } from "@/server/tenancy/invitations";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";
import { assertSameOrigin } from "@/server/tenancy/authz";

const schema = z.object({ token: z.string().min(10).max(200) });

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const resolved = await resolveSession(req);
  if (!resolved) {
    return NextResponse.json(
      { error: "Sign in or register with the invited email address first.", code: "not_authenticated" },
      { status: 401 },
    );
  }

  const ip = clientIp(req);
  const rl = checkAuthRateLimit(`invite-accept:${ip}`, AUTH_LIMITS.invitationAccept.limit, AUTH_LIMITS.invitationAccept.windowMs);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "Invitation token is required" }, { status: 400 });

  try {
    const result = await acceptInvitation({
      rawToken: parsed.data.token,
      user: { id: resolved.user.id, email: resolved.user.email },
      ipAddress: ip,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const mapped = invitationErrorResponse(err);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
}
