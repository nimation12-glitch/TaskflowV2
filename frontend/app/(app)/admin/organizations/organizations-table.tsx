"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { formatGbp, formatNumber, formatDate } from "@/lib/utils";
import type { AdminOrgSummary, PlanCode } from "@/lib/admin-client";

type SortKey = "name" | "plan_code" | "wallet_balance_micros" | "member_count" | "active_gpu_rental_count" | "created_at";

const PLAN_BADGE_VARIANT: Record<PlanCode, "default" | "success" | "accent"> = {
  FREE: "default",
  PRO: "success",
  MAX: "accent",
};

export function OrganizationsTable({ organizations }: { organizations: AdminOrgSummary[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDesc, setSortDesc] = useState(true);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? organizations.filter((o) => o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)) : organizations;
    const sorted = [...base].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [organizations, query, sortKey, sortDesc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  function SortHeader({ label, sortField }: { label: string; sortField: SortKey }) {
    return (
      <button onClick={() => toggleSort(sortField)} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        <ArrowUpDown className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div>
      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Search by name or ID…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
      </div>

      <div className="mt-4">
        {organizations.length === 0 ? (
          <EmptyState title="No organizations yet" description="Organizations will appear here as people sign up." />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} title="No organizations match your search" description="Try a different name or ID." />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <TableHeaderCell>
                  <SortHeader label="Organization" sortField="name" />
                </TableHeaderCell>
                <TableHeaderCell>
                  <SortHeader label="Plan" sortField="plan_code" />
                </TableHeaderCell>
                <TableHeaderCell>
                  <SortHeader label="Wallet balance" sortField="wallet_balance_micros" />
                </TableHeaderCell>
                <TableHeaderCell>
                  <SortHeader label="Members" sortField="member_count" />
                </TableHeaderCell>
                <TableHeaderCell>
                  <SortHeader label="Active rentals" sortField="active_gpu_rental_count" />
                </TableHeaderCell>
                <TableHeaderCell>
                  <SortHeader label="Created" sortField="created_at" />
                </TableHeaderCell>
              </tr>
            </TableHead>
            <TableBody>
              {filtered.map((org) => (
                <TableRow key={org.id} className="cursor-pointer">
                  <TableCell>
                    <Link href={`/admin/organizations/${org.id}`} className="font-medium hover:text-primary hover:underline">
                      {org.name}
                    </Link>
                    <p className="font-mono-data text-xs text-muted-foreground">{org.id.slice(0, 13)}…</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant={PLAN_BADGE_VARIANT[org.plan_code]}>{org.plan_code}</Badge>
                  </TableCell>
                  <TableCell className="font-mono-data">{formatGbp(org.wallet_balance_micros)}</TableCell>
                  <TableCell className="font-mono-data">{formatNumber(org.member_count)}</TableCell>
                  <TableCell className="font-mono-data">{formatNumber(org.active_gpu_rental_count)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(org.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
