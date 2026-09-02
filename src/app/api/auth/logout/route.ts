/**
 * POST /api/auth/logout — revokes the current session (Phase 1 §9, §33).
 * The row is kept with revokedAt set: session reuse after logout must fail
 * (stolen-token replay is rejected by every authenticated route).
 */
import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, resolveSession, revokeSession } from "@/server/auth/session";
import { recordAudit } from "@/server/audit";
import { assertSameOrigin } from "@/server/tenancy/authz";

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const resolved = await resolveSession(req);
  await revokeSession(req);
  if (resolved) {
    await recordAudit({ action: "logout", userId: resolved.user.id });
  }
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
