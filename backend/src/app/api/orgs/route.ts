/**
 * /api/orgs — list the signed-in user's organizations (GET) and create a new
 * one (POST, §22 multi-org support). Creation routes through the shared
 * provisioning path (org + OWNER membership + Free subscription + credits).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getOrgContext, assertSameOrigin } from "@/server/tenancy/authz";
import { createOrganization } from "@/server/tenancy/org-service";
import { clientIp } from "@/server/auth/rate-limit";

export async function GET(req: NextRequest) {
  const ctx = await getOrgContext(req);
  return NextResponse.json({
    activeOrganizationId: ctx.organization.id,
    role: ctx.role,
    organizations: ctx.memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.membership.role,
      isPersonal: m.organization.ownerUserId === ctx.user.id,
      status: m.organization.status,
    })),
  });
}

const createSchema = z.object({ name: z.string().min(1).max(60) });

export async function POST(req: NextRequest) {
  assertSameOrigin(req);
  const ctx = await getOrgContext(req);

  let parsed;
  try {
    parsed = createSchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "An organization name between 1 and 60 characters is required" }, { status: 400 });
  }

  const org = await createOrganization({
    owner: ctx.user,
    name: parsed.data.name,
    ipAddress: clientIp(req),
  });
  return NextResponse.json(
    { organization: { id: org.id, name: org.name, slug: org.slug, role: "OWNER" } },
    { status: 201 },
  );
}
