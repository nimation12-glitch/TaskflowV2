/**
 * POST /api/v1/chat/completions — THE TaskFlow AI gateway (OpenAI-compatible).
 *
 * Auth: Authorization: Bearer tf_live_…
 * Body: { model, messages, temperature?, max_tokens? }
 *
 * Pipeline: authenticate → entitlement → rate limit → credits → route →
 * meter → bill. See src/server/gateway.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { handleChatCompletion, errorPayload, type GatewayRequestBody } from "@/server/gateway";
import { extractBearerKey } from "@/server/auth/api-keys";

export async function POST(req: NextRequest) {
  let body: GatewayRequestBody;
  try {
    body = (await req.json()) as GatewayRequestBody;
  } catch {
    return NextResponse.json(
      { error: { message: "Request body must be valid JSON", type: "taskflow_error", code: "invalid_request" } },
      { status: 400 },
    );
  }

  const result = await handleChatCompletion(extractBearerKey(req), body);

  if (!result.ok) {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (result.error.retryAfterSeconds) {
      headers.set("Retry-After", String(result.error.retryAfterSeconds));
      headers.set("X-RateLimit-Retry-After", String(result.error.retryAfterSeconds));
    }
    return new NextResponse(JSON.stringify(errorPayload(result.error)), { status: result.error.status, headers });
  }

  return NextResponse.json(result.response);
}
