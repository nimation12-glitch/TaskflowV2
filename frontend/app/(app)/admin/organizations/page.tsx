import { getAdminOrganizations } from "@/lib/admin-client";
import { OrganizationsTable } from "./organizations-table";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { safe } from "@/lib/safe-fetch";

export default async function AdminOrganizationsPage() {
  const { data, ok } = await safe(getAdminOrganizations(), { organizations: [] });

  if (!ok) {
    return <UnavailableNotice label="Organizations data" />;
  }

  return (
    <div>
      <p className="text-sm text-muted-foreground">{data.organizations.length} organizations</p>
      <div className="mt-4">
        <OrganizationsTable organizations={data.organizations} />
      </div>
    </div>
  );
}
