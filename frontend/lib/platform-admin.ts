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
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
  return user?.isPlatformAdmin ?? false;
});
