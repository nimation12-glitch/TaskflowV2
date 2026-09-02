"use client";

/** API keys — list, create (raw key shown ONCE), rename, revoke. */

import { useCallback, useEffect, useState } from "react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { ComponentProps } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, post, patch, del, ApiError } from "@/lib/client-api";
import { toast } from "@/hooks/use-toast";
import type { ApiKeyRow, CreateKeyResponse } from "@/types/taskflow";
import { KeyRound, Plus, Copy, Check, ShieldAlert, Trash2, Pencil, Loader2 } from "lucide-react";

function statusBadgeProps(status: string): { variant: ComponentProps<typeof Badge>["variant"]; className: string; label: string } {
  if (status === "ACTIVE") return { variant: "outline", className: "border-emerald-300 bg-emerald-50 text-emerald-700", label: "Active" };
  return { variant: "outline", className: "border-slate-300 bg-slate-100 text-slate-500", label: "Revoked" };
}

function fmtDate(s: string | null): string {
  return s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

export function ApiKeysView() {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateKeyResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [renameTarget, setRenameTarget] = useState<ApiKeyRow | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api<{ keys: ApiKeyRow[] }>("/api/keys");
      setKeys(d.keys);
    } catch {
      toast({ title: "Could not load API keys", variant: "destructive" });
      setKeys([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await post<CreateKeyResponse>("/api/keys", { name: newName.trim() });
      setCreated(res);
      setCreateOpen(false);
      setNewName("");
      await load();
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Failed to create key", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  async function copyKey() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.rawKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed — select the key text manually", variant: "destructive" });
    }
  }

  async function revokeKey() {
    if (!revokeTarget) return;
    try {
      await del(`/api/keys/${revokeTarget.id}`);
      toast({ title: "API key revoked", description: `${revokeTarget.name} can no longer authenticate.` });
      setRevokeTarget(null);
      await load();
    } catch {
      toast({ title: "Failed to revoke key", variant: "destructive" });
    }
  }

  async function renameKey(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget || !renameValue.trim()) return;
    try {
      await patch(`/api/keys/${renameTarget.id}`, { name: renameValue.trim() });
      toast({ title: "Key renamed" });
      setRenameTarget(null);
      await load();
    } catch {
      toast({ title: "Failed to rename key", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">API keys</h2>
          <p className="text-sm text-slate-500">
            Authenticate requests with <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">Authorization: Bearer tf_live_…</code>
          </p>
        </div>
        <Button className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Create key
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Your keys</CardTitle>
          <CardDescription>
            Keys are stored as peppered SHA-256 hashes. The full key is displayed once, at creation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {keys === null ? (
            <div className="space-y-3">
              {[0, 1].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 py-12 text-center">
              <KeyRound className="mb-3 h-8 w-8 text-slate-300" />
              <p className="text-sm font-medium text-slate-700">No API keys yet</p>
              <p className="mt-1 max-w-sm text-xs text-slate-500">
                Create your first key to start calling the TaskFlow AI gateway.
              </p>
              <Button className="mt-4 bg-emerald-600 text-white hover:bg-emerald-500" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" /> Create key
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-160 text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-4 font-medium">Name</th>
                    <th className="pb-2 pr-4 font-medium">Key</th>
                    <th className="pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 pr-4 font-medium">Created</th>
                    <th className="pb-2 pr-4 font-medium">Last used</th>
                    <th className="pb-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => {
                    const st = statusBadgeProps(k.status);
                    return (
                      <tr key={k.id} className="border-b border-slate-100 last:border-0">
                        <td className="py-3 pr-4 font-medium text-slate-900">{k.name}</td>
                        <td className="py-3 pr-4">
                          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                            {k.prefix}…
                          </code>
                        </td>
                        <td className="py-3 pr-4">
                          <Badge variant={st.variant} className={st.className}>{st.label}</Badge>
                        </td>
                        <td className="py-3 pr-4 text-slate-500">{fmtDate(k.createdAt)}</td>
                        <td className="py-3 pr-4 text-slate-500">{fmtDate(k.lastUsedAt)}</td>
                        <td className="py-3 text-right">
                          <div className="flex justify-end gap-1">
                            {k.status === "ACTIVE" && (
                              <>
                                <Button
                                  variant="ghost" size="sm" className="h-8 text-slate-500"
                                  onClick={() => { setRenameTarget(k); setRenameValue(k.name); }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-8 text-rose-500 hover:bg-rose-50 hover:text-rose-600"
                                  onClick={() => setRevokeTarget(k)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" /> Revoke
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) setCreateOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>
              Give the key a name so you can recognise it later.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createKey}>
            <div className="space-y-2 py-2">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                placeholder="e.g. Production backend"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
                autoFocus
              />
            </div>
            <DialogFooter className="mt-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={creating || !newName.trim()} className="bg-emerald-600 text-white hover:bg-emerald-500">
                {creating && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Create key
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Raw key shown once */}
      <Dialog open={!!created} onOpenChange={(open) => { if (!open) setCreated(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" /> Save your key now
            </DialogTitle>
            <DialogDescription>
              This is the only time the full key is shown. TaskFlow stores only a hash — we cannot recover it.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="mb-1.5 text-xs font-medium text-amber-800">
              {created?.key.name} · {created?.key.prefix}…
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-white px-2.5 py-2 text-xs text-slate-800 ring-1 ring-amber-200">
                {created?.rawKey}
              </code>
              <Button size="sm" variant="outline" className="h-9 shrink-0 border-amber-300 bg-white hover:bg-amber-100" onClick={copyKey}>
                {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => setCreated(null)}>
              I&apos;ve saved my key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{revokeTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Requests using this key will start failing immediately with 401. This cannot be undone —
              create a new key if you need access again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-rose-600 text-white hover:bg-rose-500" onClick={revokeKey}>
              Revoke key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename key</DialogTitle>
            <DialogDescription>
              Choose a name that helps you recognise this key later. The key itself does not change.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={renameKey}>
            <div className="space-y-2 py-2">
              <Label htmlFor="rename-key">Key name</Label>
              <Input
                id="rename-key"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                maxLength={60}
                autoFocus
              />
            </div>
            <DialogFooter className="mt-2">
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
              <Button type="submit" className="bg-emerald-600 text-white hover:bg-emerald-500" disabled={!renameValue.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
