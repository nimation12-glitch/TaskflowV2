/**
 * Global API origin gate (Next.js 16 proxy — the successor of middleware).
 *
 * Rejects cross-site MUTATING /api requests with a proper 403 BEFORE any
 * route handler runs — uniformly across every endpoint (auth, orgs,
 * billing, keys, …), fixing the inconsistency where route handlers without
 * an OrgContextError mapper answered CSRF rejections with 500.
 *
 * Combined with SameSite=Lax session cookies this closes classic CSRF
 * (correction spec §7/§14): the Origin must match the request host,
 * APP_BASE_URL, or an explicit TRUSTED_ORIGINS entry — arbitrary hosts are
 * never trusted, so Host-header spoofing from other environments gains
 * nothing.
 *
 * Route handlers keep their in-handler assertSameOrigin() calls as a
 * second layer (defence in depth); they now only ever see requests this
 * gate already accepted.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedOrigin, isMutatingMethod } from "@/server/origin";

export default function proxy(req: NextRequest) {
  if (!isMutatingMethod(req.method)) return NextResponse.next();
  if (isAllowedOrigin(req.headers.get("origin"), req)) return NextResponse.next();
  return NextResponse.json(
    { error: "Cross-origin request rejected" },
    { status: 403 },
  );
}

export const config = {
  matcher: "/api/:path*",
};
