/**
 * POST /api/orgs/active — switch the active organization (§23, §42).
 * The requested org id is validated against ACTUAL memberships — an
 * arbitrary/guessed org id is rejected (§24, §33). Sets the httpOnly `tf_org`
 * cookie; every subsequent request re-validates membership server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getOrgContext, ORG_COOKIE, assertSameOrigin } from "@/server/tenancy/authz";
import { recordAudit } from "@/server/audit";

const schema = z.object({ organizationId: z.string().min(1).max(64) });

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const ctx = await getOrgContext(req);

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "organizationId is required" }, { status: 400 });

  const membership = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId: parsed.data.organizationId, userId: ctx.user.id } },
    include: { organization: true },
  });
  if (!membership) {
    return NextResponse.json({ error: "You are not a member of that organization" }, { status: 403 });
  }
  if (membership.organization.status !== "ACTIVE") {
    return NextResponse.json({ error: "That organization is not active" }, { status: 403 });
  }

  await recordAudit({
    action: "org_switched",
    userId: ctx.user.id,
    organizationId: membership.organizationId,
  });

  const res = NextResponse.json({
    ok: true,
    organization: { id: membership.organization.id, name: membership.organization.name, slug: membership.organization.slug },
    role: membership.role,
  });
  res.cookies.set(ORG_COOKIE, membership.organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 180 * 24 * 60 * 60,
    path: "/",
  });
  return res;
}
