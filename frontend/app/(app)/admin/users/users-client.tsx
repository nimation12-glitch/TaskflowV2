"use client";

import { DialogTrigger } from "@radix-ui/react-dialog";
import { ShieldBan, ShieldCheck, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatDate } from "@/lib/utils";
import { banUserAction, unbanUserAction, setSiteRoleAction } from "./actions";

export type AdminUserRow = {
  id: string;
  name: string | null;
  email: string;
  siteRole: "OWNER" | "ADMIN" | "USER";
  banned: boolean;
  bannedReason: string | null;
  createdAt: string;
  workspaces: { id: string; name: string; role: string }[];
};

const ROLE_VARIANT: Record<string, "accent" | "default" | "outline"> = {
  OWNER: "accent",
  ADMIN: "default",
  MEMBER: "outline",
};

const MEMBER_ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
};

export function UsersClient({
  rows,
  viewerId,
  viewerSiteRole,
}: {
  rows: AdminUserRow[];
  viewerId: string;
  viewerSiteRole: "OWNER" | "ADMIN" | "USER";
}) {
  const { pending, run } = useAction();
  const isOwner = viewerSiteRole === "OWNER";

  function ban(row: AdminUserRow) {
    run(() => banUserAction(row.id), {
      success: `${row.email} has been banned`,
      error: "Couldn't ban this account",
    });
  }

  function unban(row: AdminUserRow) {
    run(() => unbanUserAction(row.id), {
      success: `${row.email} can sign in again`,
      error: "Couldn't unban this account",
    });
  }

  function setRole(row: AdminUserRow, role: "ADMIN" | "USER") {
    run(() => setSiteRoleAction(row.id, role), {
      success: role === "ADMIN" ? `${row.email} is now an admin` : `${row.email} is now a standard user`,
      error: "Couldn't update the site role",
    });
  }

  // Which destructive/role actions are allowed — mirrored server-side in
  // users/actions.ts; this only shapes the UI.
  function canBan(row: AdminUserRow) {
    if (row.banned || row.siteRole === "OWNER") return false;
    if (row.id === viewerId) return false;
    return isOwner || row.siteRole === "USER";
  }

  function canUnban(row: AdminUserRow) {
    if (!row.banned) return false;
    return isOwner || row.siteRole === "USER";
  }

  function canGrantAdmin(row: AdminUserRow) {
    return isOwner && row.id !== viewerId && row.siteRole === "USER";
  }

  function canRevokeAdmin(row: AdminUserRow) {
    return isOwner && row.id !== viewerId && row.siteRole === "ADMIN";
  }

  return (
    <div className="divide-y divide-border rounded-lg border border-border">
      {rows.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <Avatar label={row.email} />
            <div>
              <p className="text-sm font-medium">{row.name ?? "—"}</p>
              <p className="text-xs text-muted-foreground">{row.email}</p>
              <p className="text-xs text-muted-foreground">Joined {formatDate(row.createdAt)}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {row.workspaces.length > 0 ? (
              row.workspaces.map((w) => (
                <span key={w.id} className="text-xs text-muted-foreground">
                  {w.name} <Badge variant={ROLE_VARIANT[w.role] ?? "outline"}>{MEMBER_ROLE_LABEL[w.role] ?? w.role}</Badge>
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">No workspace</span>
            )}

            <Badge variant={row.siteRole === "USER" ? "outline" : row.siteRole === "OWNER" ? "accent" : "default"}>
              {row.siteRole === "USER" ? "Standard user" : row.siteRole}
            </Badge>
            {row.banned ? (
              <Badge variant="danger">
                <ShieldBan className="h-3 w-3" /> Banned
              </Badge>
            ) : (
              <Badge variant="success">Active</Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            {canGrantAdmin(row) && (
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => setRole(row, "ADMIN")}>
                <UserCog className="h-4 w-4" />
                Make admin
              </Button>
            )}
            {canRevokeAdmin(row) && (
              <ConfirmDialog
                trigger={
                  <DialogTrigger asChild>
                    <Button variant="secondary" size="sm">
                      Revoke admin
                    </Button>
                  </DialogTrigger>
                }
                title={`Revoke admin from ${row.email}?`}
                description="They immediately lose access to the admin panel and all admin powers."
                confirmLabel="Revoke admin"
                variant="danger"
                pending={pending}
                onConfirm={() => setRole(row, "USER")}
              />
            )}
            {canUnban(row) && (
              <ConfirmDialog
                trigger={
                  <DialogTrigger asChild>
                    <Button variant="secondary" size="sm">
                      <ShieldCheck className="h-4 w-4" />
                      Unban
                    </Button>
                  </DialogTrigger>
                }
                title={`Unban ${row.email}?`}
                description="They'll be able to sign in and use TaskFlow again."
                confirmLabel="Unban account"
                pending={pending}
                onConfirm={() => unban(row)}
              />
            )}
            {canBan(row) && (
              <ConfirmDialog
                trigger={
                  <DialogTrigger asChild>
                    <Button variant="danger" size="sm">
                      Ban
                    </Button>
                  </DialogTrigger>
                }
                title={`Ban ${row.email}?`}
                description="They'll be signed out, unable to sign in, and lose access to their workspace and rentals until unbanned."
                confirmLabel="Ban account"
                variant="danger"
                pending={pending}
                onConfirm={() => ban(row)}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
