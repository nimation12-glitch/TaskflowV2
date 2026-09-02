/**
 * GET /api/dev/sms-outbox — DEVELOPMENT/TEST ONLY.
 *
 * Returns the SmsMessage outbox so the sandbox can complete phone
 * verification end-to-end without a real SMS provider (the dev transport
 * stores the code inside the message body). Returns 404 in production
 * (fail closed) — the route does not exist there, and production outbox
 * rows are code-free regardless (§46).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverEnv } from "@/server/env";

export async function GET(req: NextRequest) {
  if (serverEnv.isProduction) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const to = new URL(req.url).searchParams.get("to");
  const messages = await db.smsMessage.findMany({
    where: to ? { to } : undefined,
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return NextResponse.json({ messages });
}
