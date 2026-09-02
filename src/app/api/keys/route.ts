/**
 * /api/keys — list (GET) and create (POST) API keys, ORGANIZATION-SCOPED
 * (Phase 1 §24, §27). Keys belong to the active organization; any member can
 * list, creation requires ADMIN+. Raw keys are returned EXACTLY ONCE at
 * creation; only hash + prefix persist.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrgRole, OrgContextError } from "@/server/tenancy/authz";
import { generateRawKey } from "@/server/auth/api-keys";

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireOrgRole(req, "MEMBER");
    const keys = await db.apiKey.findMany({
      where: { organizationId: ctx.organization.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        prefix: true,
        status: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
        permissions: true,
        user: { select: { name: true, email: true } },
      },
    });
    return NextResponse.json({
      keys: keys.map((k) => ({ ...k, createdBy: k.user?.name ?? k.user?.email ?? null, user: undefined })),
    });
  } catch (err) {
    if (err instanceof OrgContextError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(60),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireOrgRole(req, "ADMIN");

    let parsed;
    try {
      parsed = createSchema.safeParse(await req.json());
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!parsed.success) {
      return NextResponse.json({ error: "A key name between 1 and 60 characters is required" }, { status: 400 });
    }

    // Guard against key sprawl per ORGANIZATION (cost/abuse control).
    const activeCount = await db.apiKey.count({
      where: { organizationId: ctx.organization.id, status: "ACTIVE" },
    });
    if (activeCount >= 25) {
      return NextResponse.json(
        { error: "Active API key limit reached (25). Revoke unused keys first." },
        { status: 409 },
      );
    }

    const { raw, prefix, keyHash } = generateRawKey();
    const key = await db.apiKey.create({
      data: {
        organizationId: ctx.organization.id,
        userId: ctx.user.id, // creating member (attribution)
        name: parsed.data.name,
        prefix,
        keyHash,
      },
    });

    return NextResponse.json(
      {
        key: {
          id: key.id,
          name: key.name,
          prefix: key.prefix,
          status: key.status,
          createdAt: key.createdAt,
        },
        // The ONLY time the raw key is ever returned.
        rawKey: raw,
        warning: "Copy this key now — it will not be shown again. TaskFlow stores only a hash.",
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof OrgContextError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
