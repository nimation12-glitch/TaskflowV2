/**
 * /api/orgs/[orgId]/invitations/[id] — DELETE revoke a pending invitation
 * (OWNER/ADMIN, §19). Revoked invitations can never be accepted.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOrgMember, assertSameOrigin } from "@/server/tenancy/authz";
import { revokeInvitation, invitationErrorResponse } from "@/server/tenancy/invitations";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ orgId: string; id: string }> }) {
  assertSameOrigin(req);
  const { orgId, id } = await params;
  const ctx = await requireOrgMember(req, orgId, "ADMIN");

  try {
    await revokeInvitation(id, orgId, ctx.user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const mapped = invitationErrorResponse(err);
    return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  }
}
