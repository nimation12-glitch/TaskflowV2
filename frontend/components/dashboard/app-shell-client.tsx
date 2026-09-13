"use client";

import { useState } from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Sidebar } from "./sidebar";
import { UserMenu } from "./user-menu";
import { MobileNav } from "./mobile-nav";
import { LogoMark } from "@/components/logo-mark";
import { cn } from "@/lib/utils";

export function AppShellClient({
  admin,
  email,
  role,
  children,
}: {
  admin: boolean;
  email: string;
  role?: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-border bg-card/30 p-4 transition-[width] duration-200 lg:flex",
          collapsed ? "w-[68px]" : "w-60"
        )}
      >
        <Link
          href="/dashboard"
          className={cn("flex items-center gap-2 px-1 text-[15px] font-semibold tracking-tight", collapsed && "justify-center px-0")}
        >
          <LogoMark size={24} />
          {!collapsed && "TaskFlow"}
        </Link>

        <Sidebar admin={admin} collapsed={collapsed} />

        <div className="mt-auto flex flex-col gap-1 border-t border-border pt-3">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground",
              collapsed && "justify-center px-2"
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            {!collapsed && "Collapse"}
          </button>
          <UserMenu email={email} role={role} collapsed={collapsed} />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <LogoMark size={24} />
          TaskFlow
        </Link>
        <MobileNav admin={admin} email={email} role={role} />
      </header>

      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
