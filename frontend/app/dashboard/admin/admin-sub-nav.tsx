"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/dashboard/admin", label: "Maintenance", exact: true },
  { href: "/dashboard/admin/organizations", label: "Organizations", exact: false },
];

export function AdminSubNav() {
  const pathname = usePathname();
  return (
    <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
      {TABS.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-card panel-edge text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
