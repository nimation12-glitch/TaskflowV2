/**
 * /api/orgs/[orgId]/members — team roster (GET) and management (§24, §25, §29).
 *
 * GET   — any member sees the roster (org-scoped).
 * PATCH — OWNER only: change a member's role (never the last OWNER, never
 *         elevate above ADMIN via invitation-created roles).
 * DELETE— OWNER/ADMIN: remove a member (ADMIN cannot remove OWNER/ADMIN;
 *         the last OWNER can never be removed). Leaving users use this with
 *         their own id.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrgMember, isLastOwner, OrgContextError } from "@/server/tenancy/authz";
import { recordAudit } from "@/server/audit";
import { assertSameOrigin } from "@/server/tenancy/authz";

export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const ctx = await requireOrgMember(req, orgId);

  const members = await db.membership.findMany({
    where: { organizationId: orgId },
    include: { user: { select: { id: true, name: true, email: true, avatarUrl: true, lastLoginAt: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({
    organization: { id: ctx.organization.id, name: ctx.organization.name, slug: ctx.organization.slug },
    yourRole: ctx.role,
    members: members.map((m) => ({
      membershipId: m.id,
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      createdAt: m.createdAt,
      lastLoginAt: m.user.lastLoginAt,
      isSelf: m.user.id === ctx.user.id,
    })),
  });
}

const roleSchema = z.object({ userId: z.string().min(1), role: z.enum(["OWNER", "ADMIN", "MEMBER"]) });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  assertSameOrigin(req);
  const { orgId } = await params;
  const ctx = await requireOrgMember(req, orgId, "OWNER");

  let parsed;
  try {
    parsed = roleSchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "userId and a valid role are required" }, { status: 400 });
  const { userId, role } = parsed.data;

  const target = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
  });
  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  if (target.role === "OWNER" && role !== "OWNER" && (await isLastOwner(orgId, userId))) {
    return NextResponse.json(
      { error: "Cannot demote the last owner. Transfer ownership to another member first." },
      { status: 409 },
    );
  }

  const updated = await db.membership.update({ where: { id: target.id }, data: { role } });
  await recordAudit({
    action: "role_changed",
    userId: ctx.user.id,
    organizationId: orgId,
    metadata: { targetUserId: userId, from: target.role, to: role },
  });
  return NextResponse.json({ ok: true, membershipId: updated.id, role: updated.role });
}

const removeSchema = z.object({ userId: z.string().min(1) });

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  assertSameOrigin(req);
  const { orgId } = await params;
  const ctx = await requireOrgMember(req, orgId, "ADMIN");

  let parsed;
  try {
    parsed = removeSchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "userId is required" }, { status: 400 });
  const { userId } = parsed.data;

  const target = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
  });
  if (!target) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const actorRank = ctx.role === "OWNER" ? 3 : 2;
  const targetRank = target.role === "OWNER" ? 3 : target.role === "ADMIN" ? 2 : 1;
  if (targetRank >= actorRank && target.userId !== ctx.user.id) {
    return NextResponse.json({ error: "You cannot remove a member at or above your own role" }, { status: 403 });
  }
  if (target.role === "OWNER" && (await isLastOwner(orgId, userId))) {
    return NextResponse.json({ error: "Cannot remove the last owner." }, { status: 409 });
  }

  await db.membership.delete({ where: { id: target.id } });
  await recordAudit({
    action: "member_removed",
    userId: ctx.user.id,
    organizationId: orgId,
    metadata: { removedUserId: userId, role: target.role, self: userId === ctx.user.id },
  });
  return NextResponse.json({ ok: true });
}

export { OrgContextError };
