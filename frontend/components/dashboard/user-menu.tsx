"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({ email, role }: { email: string; role?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
        <Avatar label={email} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-tight">{email}</p>
          {role && <p className="text-[11px] capitalize leading-tight text-muted-foreground">{role.toLowerCase()}</p>}
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <div className="truncate px-2.5 pb-2 text-sm">{email}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onSelect={() => signOut({ redirectTo: "/" })}>
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
