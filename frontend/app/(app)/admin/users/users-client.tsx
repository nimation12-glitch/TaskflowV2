"use client";

import { useState } from "react";
import { DialogTrigger } from "@radix-ui/react-dialog";
import { Check, Copy, Search, ShieldBan, ShieldCheck, UserCog, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatDate, formatGbp } from "@/lib/utils";
import { banUserAction, unbanUserAction, setSiteRoleAction } from "./actions";

export type AdminUserRow = {
  id: string;
  name: string | null;
  email: string;
  siteRole: "OWNER" | "ADMIN" | "USER";
  banned: boolean;
  bannedReason: string | null;
  createdAt: string;
  /** Organisation memberships — each carries that org's wallet balance. */
  workspaces: { id: string; name: string; role: string; wallet_balance_micros: number }[];
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
  const [query, setQuery] = useState("");

  // Admins search by the things they actually have in hand from a support
  // ticket: email, name, or the UUID we render on every row.
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? rows.filter(
        (row) =>
          row.email.toLowerCase().includes(needle) ||
          (row.name ?? "").toLowerCase().includes(needle) ||
          row.id.toLowerCase().includes(needle) ||
          row.workspaces.some((w) => w.name.toLowerCase().includes(needle) || w.id.toLowerCase().includes(needle))
      )
    : rows;

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
    <div>
      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by email, name or ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="mt-4 rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          No users match your search.
        </p>
      ) : (
        <div className="mt-4 divide-y divide-border rounded-lg border border-border">
      {filtered.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <Avatar label={row.email} />
            <div className="min-w-0">
              <p className="text-sm font-medium">{row.name ?? "—"}</p>
              <p className="text-xs text-muted-foreground">{row.email}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>Joined {formatDate(row.createdAt)}</span>
                <UuidCopy value={row.id} />
              </div>
              {row.banned && row.bannedReason && (
                <p className="mt-1 text-xs text-danger">Reason: {row.bannedReason}</p>
              )}
            </div>
          </div>

          <div className="flex max-w-xl flex-wrap items-center gap-2">
            {row.workspaces.length > 0 ? (
              row.workspaces.map((w) => (
                <span
                  key={w.id}
                  className="rounded-md border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
                  title={`Org ${w.id}`}
                >
                  <span className="font-medium text-foreground">{w.name}</span>{" "}
                  <Badge variant={ROLE_VARIANT[w.role] ?? "outline"}>{MEMBER_ROLE_LABEL[w.role] ?? w.role}</Badge>
                  <span className="ml-1.5 inline-flex items-center gap-1 font-mono-data">
                    <Wallet className="h-3 w-3" />
                    {formatGbp(w.wallet_balance_micros)}
                  </span>
                </span>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">No organisation</span>
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
      )}
    </div>
  );
}

/** The user's UUID with a one-click copy — admins cite this in support tickets. */
function UuidCopy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — the id is still selectable as text */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      className="inline-flex max-w-[15rem] items-center gap-1 rounded transition-colors hover:text-foreground"
    >
      <span className="truncate font-mono-data">{value}</span>
      {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
