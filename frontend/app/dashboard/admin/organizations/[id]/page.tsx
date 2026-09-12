import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getAdminOrganization } from "@/lib/admin-client";
import { OrgDetailClient } from "./org-detail-client";
import { safe } from "@/lib/safe-fetch";

export default async function AdminOrganizationDetailPage({ params }: { params: { id: string } }) {
  const { data: org, ok } = await safe(getAdminOrganization(params.id), null);

  return (
    <div>
      <Link href="/dashboard/admin/organizations" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" />
        All organizations
      </Link>

      {!ok || !org ? (
        <div className="mt-6 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Couldn't load this organization — it may not exist, or this data isn't available right now.
        </div>
      ) : (
        <>
          <h2 className="mt-3 text-xl font-semibold tracking-tight">{org.name}</h2>
          <p className="font-mono-data text-xs text-muted-foreground">{org.id}</p>
          <div className="mt-6">
            <OrgDetailClient org={org} />
          </div>
        </>
      )}
    </div>
  );
}
