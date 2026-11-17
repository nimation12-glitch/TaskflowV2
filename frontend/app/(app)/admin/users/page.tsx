import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getSiteRole } from "@/lib/platform-admin";
import { getAdminUsers, type AdminUserMembershipRow } from "@/lib/admin-client";
import { safe } from "@/lib/safe-fetch";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { UsersClient, type AdminUserRow } from "./users-client";

export default async function AdminUsersPage() {
  const session = await auth();

  const [viewerSiteRole, membershipsResult, identityUsers] = await Promise.all([
    getSiteRole(session?.user?.id),
    safe(getAdminUsers(), { users: [] as AdminUserMembershipRow[] }),
    prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        siteRole: true,
        isPlatformAdmin: true,
        bannedAt: true,
        bannedReason: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // Backend memberships give each identity user their workspace(s) and
  // role inside them; identity fields (name, email, ban, site role) come
  // from the Prisma identity DB.
  const workspaceMap = new Map<string, AdminUserMembershipRow["organizations"]>();
  for (const row of membershipsResult.data.users) {
    workspaceMap.set(row.user_id, row.organizations);
  }

  const rows: AdminUserRow[] = identityUsers.map((u) => {
    // Effective site role: the siteRole column wins; the legacy
    // isPlatformAdmin flag still counts as ADMIN (see lib/platform-admin.ts).
    const effectiveRole =
      u.siteRole === "OWNER" || u.siteRole === "ADMIN" ? u.siteRole : u.isPlatformAdmin ? "ADMIN" : "USER";
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      siteRole: effectiveRole,
      banned: u.bannedAt !== null,
      bannedReason: u.bannedReason,
      createdAt: u.createdAt.toISOString(),
      workspaces: workspaceMap.get(u.id) ?? [],
    };
  });

  return (
    <div>
      {membershipsResult.ok ? null : (
        <div className="mb-4">
          <UnavailableNotice label="Workspace membership data" />
        </div>
      )}
      <UsersClient rows={rows} viewerId={session?.user?.id ?? ""} viewerSiteRole={viewerSiteRole} />
    </div>
  );
}
