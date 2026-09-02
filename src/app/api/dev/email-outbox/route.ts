/**
 * GET /api/dev/email-outbox — DEVELOPMENT/TEST ONLY.
 *
 * Returns the EmailMessage outbox so the sandbox can exercise verification /
 * reset / invitation links end-to-end without a real mail provider. Returns
 * 404 in production (fail closed) — the route does not exist there (§46).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverEnv } from "@/server/env";

export async function GET(req: NextRequest) {
  if (serverEnv.isProduction) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const to = new URL(req.url).searchParams.get("to");
  const messages = await db.emailMessage.findMany({
    where: to ? { to: to.toLowerCase() } : undefined,
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return NextResponse.json({ messages });
}
