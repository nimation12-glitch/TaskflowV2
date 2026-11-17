import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";

export type SiteRole = "OWNER" | "ADMIN" | "USER";

/**
 * Site-level roles live on the identity User row:
 *   OWNER — the single platform owner; can grant/revoke ADMIN and ban.
 *   ADMIN — granted by the owner from the admin panel; shares the admin
 *           panel (users, organizations, maintenance) and ban powers.
 *   USER  — a standard user with no admin powers.
 *
 * This is a platform-wide role, distinct from organization membership
 * roles (OWNER/ADMIN/MEMBER of a workspace, stored in the backend DB).
 */
export const getSiteRole = cache(async (userId: string | undefined | null): Promise<SiteRole> => {
  if (!userId) return "USER";
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { siteRole: true, isPlatformAdmin: true },
    });
    if (user?.siteRole === "OWNER" || user?.siteRole === "ADMIN") return user.siteRole;
    // Legacy fallback: accounts granted admin via scripts/set-platform-admin.ts
    // before siteRole existed keep their access.
    if (user?.isPlatformAdmin) return "ADMIN";
    return "USER";
  } catch (err) {
    // Fail CLOSED, not open. This is called from the root layout (above
    // every error boundary — see app/global-error.tsx) to decide
    // maintenance-mode bypass and admin UI access. A DB hiccup must never
    // accidentally grant admin — default to plain user.
    console.error("[taskflow] getSiteRole lookup failed — defaulting to USER:", err);
    return "USER";
  }
});

/** True when this user should carry the backend's is_platform_admin claim. */
export const isPlatformAdmin = cache(async (userId: string | undefined | null): Promise<boolean> => {
  const role = await getSiteRole(userId);
  return role === "OWNER" || role === "ADMIN";
});

/** Ban state for the identity row. A non-null bannedAt means banned. */
export const getBanState = cache(
  async (userId: string | undefined | null): Promise<{ banned: boolean; reason: string | null }> => {
    if (!userId) return { banned: false, reason: null };
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { bannedAt: true, bannedReason: true },
      });
      if (!user) return { banned: false, reason: null };
      return { banned: user.bannedAt !== null, reason: user.bannedReason };
    } catch (err) {
      // Fail OPEN here, deliberately. This lookup is defense-in-depth for
      // already-open sessions; the hard gates are sign-in itself
      // (authorize + the OAuth signIn callback), which fail closed
      // naturally because they can't reach the DB anyway. Failing closed
      // here too would lock the entire app out on one transient DB error.
      console.error("[taskflow] getBanState lookup failed — allowing session (sign-in gates remain):", err);
      return { banned: false, reason: null };
    }
  }
);
