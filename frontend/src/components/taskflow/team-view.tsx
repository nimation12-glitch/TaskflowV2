"use client";

/**
 * Team view — organization members, roles, invitations and seat usage
 * (Phase 1 §29). All mutations go through org-scoped, role-guarded APIs;
 * this UI only reflects what the server authorizes.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UserPlus, Loader2, Trash2, Copy, Check } from "lucide-react";
import { api, post, del, ApiError } from "@/lib/client-api";
import { useToast } from "@/hooks/use-toast";
import type { MeResponse } from "@/types/taskflow";

type TeamResponse = {
  organization: { id: string; name: string; slug: string };
  yourRole: "OWNER" | "ADMIN" | "MEMBER";
  members: Array<{
    membershipId: string;
    userId: string;
    name: string | null;
    email: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    createdAt: string;
    lastLoginAt: string | null;
    isSelf: boolean;
  }>;
};

type InvitationsResponse = {
  invitations: Array<{ id: string; invitedEmail: string; role: string; createdAt: string; expiresAt: string }>;
  seat: { used: number; limit: number };
};

const ROLE_BADGE: Record<string, string> = {
  OWNER: "border-emerald-300 bg-emerald-100 text-emerald-800",
  ADMIN: "border-amber-300 bg-amber-100 text-amber-800",
  MEMBER: "border-slate-300 bg-slate-100 text-slate-700",
};

export function TeamView({ me, refreshMe }: { me: MeResponse; refreshMe: () => Promise<boolean> }) {
  const { toast } = useToast();
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [invites, setInvites] = useState<InvitationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const orgId = me.organization?.id;
      if (!orgId) return;
      const [t, i] = await Promise.all([
        api<TeamResponse>(`/api/orgs/${orgId}/members`),
        api<InvitationsResponse>(`/api/orgs/${orgId}/invitations`),
      ]);
      setTeam(t);
      setInvites(i);
    } catch {
      toast({ title: "Could not load the team", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [me.organization?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const canManage = team?.yourRole === "OWNER" || team?.yourRole === "ADMIN";

  async function sendInvite() {
    if (!me.organization?.id) return;
    setInviting(true);
    setInviteError(null);
    try {
      const res = await post<{ inviteUrl: string }>(`/api/orgs/${me.organization.id}/invitations`, {
        email: inviteEmail,
        role: inviteRole,
      });
      setLastInviteUrl(res.inviteUrl);
      setInviteEmail("");
      setInviteRole("MEMBER");
      toast({ title: "Invitation sent" });
      await load();
      await refreshMe();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : "Invitation failed");
    } finally {
      setInviting(false);
    }
  }

  async function revokeInvite(id: string) {
    if (!me.organization?.id) return;
    try {
      await del(`/api/orgs/${me.organization.id}/invitations/${id}`);
      toast({ title: "Invitation revoked" });
      await load();
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Revoke failed", variant: "destructive" });
    }
  }

  async function changeRole(userId: string, role: string) {
    if (!me.organization?.id) return;
    try {
      await api(`/api/orgs/${me.organization.id}/members`, {
        method: "PATCH",
        body: JSON.stringify({ userId, role }),
      });
      toast({ title: "Role updated" });
      await load();
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Update failed", variant: "destructive" });
    }
  }

  async function removeMember(userId: string) {
    if (!me.organization?.id) return;
    try {
      await api(`/api/orgs/${me.organization.id}/members`, {
        method: "DELETE",
        body: JSON.stringify({ userId }),
      });
      toast({ title: "Member removed" });
      await load();
      await refreshMe();
    } catch (err) {
      toast({ title: err instanceof ApiError ? err.message : "Remove failed", variant: "destructive" });
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
      </div>
    );
  }
  if (!team) return null;

  const seat = invites?.seat ?? { used: team.members.length, limit: 3 };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{team.organization.name}</h2>
          <p className="text-sm text-slate-500">
            Organization ID <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{team.organization.id}</code>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="border-slate-300 bg-slate-100 text-slate-700">
            {seat.used}/{seat.limit} seats
          </Badge>
          {canManage && (
            <Button
              onClick={() => { setInviteOpen(true); setLastInviteUrl(null); setInviteError(null); }}
              disabled={seat.used >= seat.limit}
              className="bg-emerald-600 text-white hover:bg-emerald-500"
            >
              <UserPlus className="mr-2 h-4 w-4" /> Invite member
            </Button>
          )}
        </div>
      </div>

      {seat.used >= seat.limit && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Seat limit reached ({seat.used}/{seat.limit}). Upgrade the plan or revoke a pending invitation to add more members.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>People with access to this organization.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden sm:table-cell">Joined</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {team.members.map((m) => (
                <TableRow key={m.membershipId}>
                  <TableCell>
                    <div className="font-medium text-slate-900">{m.name ?? "—"}{m.isSelf && <span className="ml-1.5 text-xs text-slate-400">(you)</span>}</div>
                    <div className="text-sm text-slate-500">{m.email}</div>
                  </TableCell>
                  <TableCell>
                    {team.yourRole === "OWNER" && !m.isSelf ? (
                      <Select value={m.role} onValueChange={(v) => changeRole(m.userId, v)}>
                        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="OWNER">Owner</SelectItem>
                          <SelectItem value="ADMIN">Admin</SelectItem>
                          <SelectItem value="MEMBER">Member</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="outline" className={ROLE_BADGE[m.role]}>{m.role}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-sm text-slate-500 sm:table-cell">
                    {new Date(m.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {(canManage && (team.yourRole === "OWNER" || m.role === "MEMBER")) && !m.isSelf ? (
                      <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={() => removeMember(m.userId)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending invitations</CardTitle>
          <CardDescription>Invitations that have not been accepted yet.</CardDescription>
        </CardHeader>
        <CardContent>
          {(invites?.invitations.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-500">No pending invitations.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {invites!.invitations.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{i.invitedEmail}</div>
                    <div className="text-xs text-slate-500">
                      {i.role} · expires {new Date(i.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                  {canManage && (
                    <Button variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50" onClick={() => revokeInvite(i.id)}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              They'll receive a single-use invitation link tied to their email address.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="teammate@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger id="invite-role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">Member — workspace usage</SelectItem>
                  <SelectItem value="ADMIN">Admin — keys, compute, members</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {inviteError && (
              <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{inviteError}</p>
            )}
            {lastInviteUrl && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <p className="mb-2 text-xs font-medium text-emerald-800">
                  Invitation link (email delivery not configured — share this link):
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-white px-2 py-1 text-xs text-slate-600">{lastInviteUrl}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { navigator.clipboard.writeText(lastInviteUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>Close</Button>
            <Button onClick={sendInvite} disabled={inviting || !inviteEmail} className="bg-emerald-600 text-white hover:bg-emerald-500">
              {inviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Send invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
