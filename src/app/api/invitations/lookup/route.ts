/**
 * GET /api/invitations/lookup?token=… — safe preview for the accept screen
 * (§21): org name, invited email, role, expiry. 410/404 states tell the UI
 * why the link cannot be used. Rate-limited (token guessing, §33/§34).
 */
import { NextRequest, NextResponse } from "next/server";
import { lookupInvitation, invitationErrorResponse } from "@/server/tenancy/invitations";
import { AUTH_LIMITS, checkAuthRateLimit, clientIp } from "@/server/auth/rate-limit";

export async function GET(req: NextRequest) {
  const ip = clientIp(req);
  const rl = checkAuthRateLimit(`invite-lookup:${ip}`, AUTH_LIMITS.invitationAccept.limit, AUTH_LIMITS.invitationAccept.windowMs);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Invitation token is required" }, { status: 400 });

  try {
    const invitation = await lookupInvitation(token);
    return NextResponse.json({
      organizationName: invitation.organizationName,
      invitedEmail: invitation.invitedEmail,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    });
  } catch (err) {
    const mapped = invitationErrorResponse(err);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
}
