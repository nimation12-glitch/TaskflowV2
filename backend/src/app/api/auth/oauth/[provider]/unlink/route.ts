/**
 * POST /api/auth/oauth/[provider]/unlink — remove a connected provider
 * identity from the signed-in account (§7, §28). Lock-out protected: the
 * last usable credential (password OR ≥1 identity) cannot be removed.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveSession } from "@/server/auth/session";
import { unlinkIdentity, IdentityError } from "@/server/auth/oauth/identities";
import { assertSameOrigin } from "@/server/tenancy/authz";

const schema = z.object({ identityId: z.string().min(1).max(64) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  assertSameOrigin(req);
  const resolved = await resolveSession(req);
  if (!resolved) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { provider } = await params;

  let parsed;
  try {
    parsed = schema.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) return NextResponse.json({ error: "identityId is required" }, { status: 400 });

  try {
    await unlinkIdentity(resolved.user.id, parsed.data.identityId, req.headers.get("x-forwarded-for"));
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof IdentityError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
