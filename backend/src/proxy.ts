/**
 * Global API origin gate + CORS edge (Next.js 16 proxy).
 *
 * CSRF: rejects cross-site MUTATING /api requests with 403 before any route
 * handler runs — the Origin must match the request host, APP_BASE_URL, or an
 * explicit TRUSTED_ORIGINS entry. Arbitrary hosts are never trusted.
 *
 * CORS (split deployments): the Vercel frontend calls this API cross-origin,
 * so trusted cross-origin requests get Access-Control-Allow-* headers and
 * preflights (OPTIONS) are answered here directly. One trust list —
 * serverEnv.trustedOrigins — drives BOTH decisions (see server/origin.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { corsHeadersFor, isAllowedOrigin, isMutatingMethod, preflightResponse } from "@/server/origin";

function withCors(res: NextResponse, cors: Record<string, string> | null): NextResponse {
  if (cors) {
    for (const [key, value] of Object.entries(cors)) res.headers.set(key, value);
  }
  return res;
}

export default function proxy(req: NextRequest) {
  const origin = req.headers.get("origin");
  const cors = corsHeadersFor(origin, req);

  // Preflight never reaches a route handler — answered at the edge.
  if (req.method === "OPTIONS") {
    return cors ? preflightResponse(origin as string) : new NextResponse(null, { status: 403 });
  }

  if (!isMutatingMethod(req.method)) return withCors(NextResponse.next(), cors);
  if (isAllowedOrigin(origin, req)) return withCors(NextResponse.next(), cors);
  return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403 });
}

export const config = {
  matcher: "/api/:path*",
};
