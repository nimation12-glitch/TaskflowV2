"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({ email, role, collapsed = false }: { email: string; role?: string; collapsed?: boolean }) {
  const trigger = (
    <DropdownMenuTrigger
      className={
        collapsed
          ? "flex w-full items-center justify-center rounded-md p-1.5 transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          : "flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      }
    >
      <Avatar label={email} size="sm" />
      {!collapsed && (
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium leading-tight">{email}</p>
          {role && <p className="text-[11px] capitalize leading-tight text-muted-foreground">{role.toLowerCase()}</p>}
        </div>
      )}
    </DropdownMenuTrigger>
  );

  return (
    <DropdownMenu>
      {collapsed ? (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="right">{email}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <div className="truncate px-2.5 pb-2 text-sm">{email}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onSelect={() => signOut({ redirectTo: "/login" })}>
          <LogOut className="h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
