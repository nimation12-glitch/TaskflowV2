/**
 * /api/keys/[id] — PATCH (rename) and DELETE (revoke) a key.
 * ORGANIZATION-SCOPED (Phase 1 §24): the key must belong to the caller's
 * active organization — cross-org key access returns 404. Mutations require
 * ADMIN+ (§25). Revocation is permanent: the hash is destroyed, not flipped.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrgRole, OrgContextError } from "@/server/tenancy/authz";

const patchSchema = z.object({ name: z.string().min(1).max(60) });

type Guard = { error?: NextResponse; key?: { id: string; status: string } };

async function getOrgKey(req: NextRequest, id: string, minRole: "MEMBER" | "ADMIN"): Promise<Guard> {
  try {
    const ctx = await requireOrgRole(req, minRole);
    const key = await db.apiKey.findFirst({
      where: { id, organizationId: ctx.organization.id },
      select: { id: true, status: true },
    });
    if (!key) return { error: NextResponse.json({ error: "API key not found" }, { status: 404 }) };
    return { key };
  } catch (err) {
    if (err instanceof OrgContextError) {
      return { error: NextResponse.json({ error: err.message }, { status: err.status }) };
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const owned = await getOrgKey(req, id, "ADMIN");
  if (owned.error) return owned.error;

  let parsed;
  try {
    parsed = patchSchema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "A key name between 1 and 60 characters is required" }, { status: 400 });
  }

  const key = await db.apiKey.update({
    where: { id },
    data: { name: parsed.data.name },
  });
  return NextResponse.json({
    key: { id: key.id, name: key.name, prefix: key.prefix, status: key.status, createdAt: key.createdAt },
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const owned = await getOrgKey(req, id, "ADMIN");
  if (owned.error) return owned.error;
  if (owned.key!.status === "REVOKED") {
    return NextResponse.json({ error: "Key is already revoked" }, { status: 409 });
  }

  await db.apiKey.update({
    where: { id },
    data: { status: "REVOKED", revokedAt: new Date(), keyHash: `revoked:${id}` },
  });
  return NextResponse.json({ ok: true, revoked: id });
}
