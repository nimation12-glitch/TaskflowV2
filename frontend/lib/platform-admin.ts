import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";

/**
 * Looks up whether a user is a platform admin, straight from Prisma rather
 * than through the NextAuth session — deliberately avoids touching auth.ts's
 * JWT/session callbacks (off-limits per project constraints), and this is
 * the only source of truth anyway: is_platform_admin is claim-only, minted
 * fresh onto the backend JWT per request, never cached in a long-lived
 * session token.
 *
 * Wrapped in React's cache() so multiple calls within the same server
 * request (e.g. several backendFetch calls on one page) collapse into a
 * single Prisma query instead of one per call.
 */
export const isPlatformAdmin = cache(async (userId: string | undefined | null): Promise<boolean> => {
  if (!userId) return false;
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
    return user?.isPlatformAdmin ?? false;
  } catch (err) {
    // Fail CLOSED, not open. This is called from the root layout (above
    // every error boundary — see app/global-error.tsx) to decide
    // maintenance-mode bypass and admin UI access. A DB hiccup or pending
    // migration must never accidentally grant admin — default to false and
    // treat the caller as an ordinary, non-admin user.
    console.error("[taskflow] isPlatformAdmin lookup failed — defaulting to false:", err);
    return false;
  }
});