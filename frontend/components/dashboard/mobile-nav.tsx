"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Sheet, SheetTrigger, SheetContent } from "@/components/ui/sheet";
import { Sidebar } from "./sidebar";
import { UserMenu } from "./user-menu";

export function MobileNav({ admin, email, role }: { admin: boolean; email: string; role?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </SheetTrigger>
      <SheetContent>
        <Link href="/" className="flex items-center gap-2 px-2 text-[15px] font-semibold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="h-2 w-2 rounded-sm bg-current" />
          </span>
          TaskFlow
        </Link>
        <div className="flex-1 overflow-y-auto">
          <Sidebar admin={admin} onNavigate={() => setOpen(false)} />
        </div>
        <div className="border-t border-border pt-3">
          <UserMenu email={email} role={role} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
