import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const isDashboard = req.nextUrl.pathname.startsWith("/dashboard");
  if (isDashboard && !req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Forwarded so the root layout can read the current path (via next/headers)
  // to exempt the sign-in/account-recovery routes from the maintenance-mode
  // gate — without this, enabling maintenance mode could lock an admin out
  // of the one page they need to log in and turn it back off.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
