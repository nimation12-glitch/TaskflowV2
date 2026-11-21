import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getSiteRole } from "@/lib/platform-admin";
import { getAdminUsers, getAdminOrganizations, type AdminUserMembershipRow } from "@/lib/admin-client";
import { safe } from "@/lib/safe-fetch";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { UsersClient, type AdminUserRow } from "./users-client";

export default async function AdminUsersPage() {
  const session = await auth();

  const [viewerSiteRole, membershipsResult, orgsResult, identityUsers] = await Promise.all([
    getSiteRole(session?.user?.id),
    safe(getAdminUsers(), { users: [] as AdminUserMembershipRow[] }),
    safe(getAdminOrganizations(), { organizations: [] }),
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

  // Backend memberships give each identity user their organisation(s) and
  // role inside them; identity fields (name, email, ban, site role) come
  // from the Prisma identity DB. Credits live on the organisation (the
  // backend has no per-user balance), so each membership carries its own
  // org's wallet balance — that's the number that means "credits" for a user.
  const orgBalanceById = new Map<string, number>();
  for (const org of orgsResult.data.organizations) {
    orgBalanceById.set(org.id, org.wallet_balance_micros);
  }

  type OrgMembershipWithCredits = { id: string; name: string; role: string; wallet_balance_micros: number };
  const workspaceMap = new Map<string, OrgMembershipWithCredits[]>();
  for (const row of membershipsResult.data.users) {
    workspaceMap.set(
      row.user_id,
      row.organizations.map((o) => ({
        ...o,
        wallet_balance_micros: orgBalanceById.get(o.id) ?? 0,
      }))
    );
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
      {membershipsResult.ok && orgsResult.ok ? null : (
        <div className="mb-4">
          <UnavailableNotice label="Workspace membership data" />
        </div>
      )}
      <UsersClient rows={rows} viewerId={session?.user?.id ?? ""} viewerSiteRole={viewerSiteRole} />
    </div>
  );
}
