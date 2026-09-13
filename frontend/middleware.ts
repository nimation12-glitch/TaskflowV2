import { auth } from "@/auth";
import { NextResponse } from "next/server";

// Every top-level route inside the (app) route group — kept as an explicit
// list rather than "everything not public" so a new public page never
// accidentally ends up behind auth just because someone forgot to exempt it.
const PROTECTED_PREFIXES = ["/dashboard", "/compute", "/billing", "/models", "/team", "/api-keys", "/account", "/admin", "/help"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isProtected && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Forwarded so the root layout can read the current path (via next/headers)
  // to exempt the sign-in/account-recovery routes from the maintenance-mode
  // gate — without this, enabling maintenance mode could lock an admin out
  // of the one page they need to log in and turn it back off.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
