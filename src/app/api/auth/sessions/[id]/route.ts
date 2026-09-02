/**
 * DELETE /api/auth/sessions/[id] — revoke one session of the signed-in user
 * (§9, §28). Scope-checked: a user can only revoke their OWN sessions.
 * `?scope=all` revokes every live session ("sign out everywhere").
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSession, revokeAllUserSessions } from "@/server/auth/session";
import { recordAudit } from "@/server/audit";
import { assertSameOrigin } from "@/server/tenancy/authz";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  assertSameOrigin(req);
  const resolved = await resolveSession(req);
  if (!resolved) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { user, session } = resolved;

  const { id } = await params;

  if (id === "all" || new URL(req.url).searchParams.get("scope") === "all") {
    // Keep the session the user is actively using (they can still log out).
    const count = await db.session.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: session.id } },
      data: { revokedAt: new Date() },
    });
    await recordAudit({ action: "session_revoked", userId: user.id, metadata: { scope: "all-others", count: count.count } });
    return NextResponse.json({ ok: true, revoked: count.count });
  }

  const target = await db.session.findUnique({ where: { id } });
  if (!target || target.userId !== user.id) {
    // Not yours → 404 (never confirm existence of another user's session).
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  await db.session.update({ where: { id: target.id }, data: { revokedAt: new Date() } });
  await recordAudit({ action: "session_revoked", userId: user.id, metadata: { sessionId: target.id } });
  return NextResponse.json({ ok: true });
}
