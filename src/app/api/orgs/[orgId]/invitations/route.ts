/**
 * /api/orgs/[orgId]/invitations — list pending invitations (GET, any member)
 * and create one (POST, OWNER/ADMIN per §19/§25). Seat limit is plan-derived
 * and counts memberships + pending invitations (§20).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrgMember, assertSameOrigin } from "@/server/tenancy/authz";
import { createInvitation, getSeatUsage, invitationErrorResponse } from "@/server/tenancy/invitations";
import { clientIp } from "@/server/auth/rate-limit";
import { serverEnv } from "@/server/env";

export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const ctx = await requireOrgMember(req, orgId);

  const [invitations, seat] = await Promise.all([
    db.invitation.findMany({
      where: { organizationId: orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { id: true, invitedEmail: true, role: true, createdAt: true, expiresAt: true },
    }),
    getSeatUsage(orgId),
  ]);

  return NextResponse.json({ invitations, seat });
}

const inviteSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  assertSameOrigin(req);
  const { orgId } = await params;
  const ctx = await requireOrgMember(req, orgId, "ADMIN");

  let parsed;
  try {
    parsed = inviteSchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid email and role (ADMIN or MEMBER) are required" }, { status: 400 });
  }

  try {
    const { rawToken, expiresAt } = await createInvitation({
      organizationId: orgId,
      invitedBy: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name },
      email: parsed.data.email,
      role: parsed.data.role,
      ipAddress: clientIp(req),
    });
    // The raw token IS returned to the authorized inviter only — the UI can
    // show a copyable link when email delivery is unconfigured. It is never
    // again retrievable (only the hash is stored, §19).
    return NextResponse.json(
      {
        ok: true,
        invitation: { email: parsed.data.email, role: parsed.data.role, expiresAt },
        inviteUrl: `${serverEnv.appBaseUrl.replace(/\/$/, "")}/#/invite?token=${encodeURIComponent(rawToken)}`,
      },
      { status: 201 },
    );
  } catch (err) {
    const mapped = invitationErrorResponse(err);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
}
