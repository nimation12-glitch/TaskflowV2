/**
 * GET /api/auth/sessions — list the signed-in user's live sessions (§28):
 * device metadata, creation, last use. Token hashes are NEVER returned (§40).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveSession } from "@/server/auth/session";

export async function GET(req: NextRequest) {
  const resolved = await resolveSession(req);
  if (!resolved) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const sessions = await db.session.findMany({
    where: { userId: resolved.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      ipAddress: true,
      userAgent: true,
    },
  });

  return NextResponse.json({
    currentSessionId: resolved.session.id,
    sessions: sessions.map((s) => ({
      ...s,
      isCurrent: s.id === resolved.session.id,
      // Truncate UA to a friendly device hint — never echo the full UA string.
      deviceHint: s.userAgent ? s.userAgent.slice(0, 60) : "Unknown device",
    })),
  });
}
