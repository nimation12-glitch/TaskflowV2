"use client";

import { useState } from "react";
import { UserPlus, Mail, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatDate } from "@/lib/utils";
import { inviteMemberAction, removeMemberAction } from "./actions";

type Member = { user_id: string; role: string; joined_at: string };
type Invitation = { id: string; invited_email: string; role: string; expires_at: string };

const ROLE_VARIANT: Record<string, "accent" | "default" | "outline"> = {
  OWNER: "accent",
  ADMIN: "default",
  MEMBER: "outline",
};

function InviteDialog({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const { pending, run } = useAction();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    run(() => inviteMemberAction(email, role), {
      success: `Invitation sent to ${email}`,
      error: "Couldn't send the invitation",
      onSuccess: () => {
        setOpen(false);
        setEmail("");
        setRole("MEMBER");
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>
          <UserPlus className="h-4 w-4" />
          Invite teammate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>They'll get an email with a link to join this workspace.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" required placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <div className="flex gap-2">
              {(["MEMBER", "ADMIN"] as const).map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setRole(r)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    role === r ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {r === "MEMBER" ? "Member" : "Admin"}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {role === "MEMBER" ? "Can use the API and view usage." : "Can also manage the team and billing."}
            </p>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" loading={pending} disabled={!email.trim()}>
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TeamClient({
  members,
  invitations,
  canManage,
  seatCount,
  maxSeats,
}: {
  members: Member[];
  invitations: Invitation[];
  canManage: boolean;
  seatCount: number;
  maxSeats: number;
}) {
  const { pending, run } = useAction();
  const atLimit = seatCount >= maxSeats;

  function handleRemove(userId: string) {
    run(() => removeMemberAction(userId), { success: "Member removed", error: "Couldn't remove member" });
  }

  return (
    <div className="max-w-2xl">
      {canManage && (
        <div className="mt-6">
          <InviteDialog disabled={atLimit} />
          {atLimit && (
            <p className="mt-2 text-sm text-warning">
              You've reached your plan's member limit. Upgrade to invite more people.
            </p>
          )}
        </div>
      )}

      <h2 className="mt-8 text-sm font-medium text-muted-foreground">Members</h2>
      <div className="mt-3 divide-y divide-border rounded-lg border border-border">
        {members.map((m) => (
          <div key={m.user_id} className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <Avatar label={m.user_id} />
              <div>
                <p className="font-mono-data text-sm">{m.user_id.slice(0, 13)}…</p>
                <p className="text-xs text-muted-foreground">Joined {formatDate(m.joined_at)}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant={ROLE_VARIANT[m.role] ?? "outline"}>{m.role}</Badge>
              {canManage && m.role !== "OWNER" && (
                <ConfirmDialog
                  trigger={
                    <DialogTrigger asChild>
                      <Button variant="danger" size="sm">
                        Remove
                      </Button>
                    </DialogTrigger>
                  }
                  title="Remove this member?"
                  description="They'll immediately lose access to this workspace, including any API keys tied to their account."
                  confirmLabel="Remove member"
                  variant="danger"
                  pending={pending}
                  onConfirm={() => handleRemove(m.user_id)}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      {invitations.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-medium text-muted-foreground">Pending invitations</h2>
          <div className="mt-3 divide-y divide-border rounded-lg border border-border">
            {invitations.map((i) => (
              <div key={i.id} className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Mail className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm">{i.invited_email}</p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" /> Expires {formatDate(i.expires_at)}
                    </p>
                  </div>
                </div>
                <Badge variant={ROLE_VARIANT[i.role] ?? "outline"}>{i.role}</Badge>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
