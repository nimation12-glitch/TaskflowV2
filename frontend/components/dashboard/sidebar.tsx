"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { NAV_SECTIONS, ADMIN_NAV_ITEM, type NavItem } from "./nav-config";

export function Sidebar({
  admin,
  onNavigate,
  collapsed = false,
}: {
  admin?: boolean;
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const pathname = usePathname();

  const sections = admin
    ? [...NAV_SECTIONS, { label: "Platform", items: [ADMIN_NAV_ITEM] }]
    : NAV_SECTIONS;

  function renderItem(item: NavItem) {
    const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
    const Icon = item.icon;
    const link = (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
          collapsed && "justify-center px-2",
          active ? "bg-muted/70 text-foreground" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        )}
      >
        <span
          className={cn(
            "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity",
            active ? "opacity-100" : "opacity-0"
          )}
        />
        <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        {!collapsed && item.label}
      </Link>
    );

    if (!collapsed) return link;
    return (
      <Tooltip key={item.href} delayDuration={300}>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <nav className="mt-8 flex flex-col gap-5">
      {sections.map((section) => (
        <div key={section.label}>
          {!collapsed && (
            <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{section.label}</p>
          )}
          <div className="flex flex-col gap-0.5">{section.items.map(renderItem)}</div>
        </div>
      ))}
    </nav>
  );
}
