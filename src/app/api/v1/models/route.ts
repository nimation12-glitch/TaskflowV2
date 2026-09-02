/**
 * GET /api/v1/models — OpenAI-style model listing for API key holders.
 * Returns only models entitled to the key holder's current plan.
 */
import { NextRequest, NextResponse } from "next/server";
import { handleListModels, errorPayload } from "@/server/gateway";
import { extractBearerKey } from "@/server/auth/api-keys";

export async function GET(req: NextRequest) {
  const result = await handleListModels(extractBearerKey(req));
  if (!result.ok) {
    return NextResponse.json(errorPayload(result.error), { status: result.error.status });
  }
  return NextResponse.json({ object: "list", data: result.data });
}
