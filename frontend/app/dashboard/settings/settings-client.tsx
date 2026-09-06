"use client";

import { useMemo, useState } from "react";
import { KeyRound, Copy, Check, Plus, Trash2, LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogTrigger } from "@/components/ui/dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatDate } from "@/lib/utils";
import { addSshKeyAction, deleteSshKeyAction, validatePublicKey } from "./actions";
import type { SshKey } from "@/lib/compute-types";

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
      <code className="font-mono-data text-xs">{command}</code>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function SshKeysSection({ keys, activeRentalKeyIds }: { keys: SshKey[]; activeRentalKeyIds: string[] }) {
  const [label, setLabel] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const { pending, run } = useAction();

  const validationError = useMemo(() => (publicKey.trim() ? validatePublicKey(publicKey) : null), [publicKey]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validatePublicKey(publicKey)) return;
    run(() => addSshKeyAction(label, publicKey), {
      success: `"${label}" added`,
      error: "Couldn't add that key",
      onSuccess: () => {
        setLabel("");
        setPublicKey("");
      },
    });
  }

  function handleDelete(id: string) {
    run(() => deleteSshKeyAction(id), { success: "Key removed", error: "Couldn't remove that key" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">SSH keys</CardTitle>
        <CardDescription>Used to connect to your GPU rentals over SSH.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No SSH keys yet"
            description="Add one to rent a GPU."
          />
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {keys.map((k) => {
              const inUse = activeRentalKeyIds.includes(k.id);
              return (
                <div key={k.id} className="flex items-center justify-between p-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{k.label}</p>
                      {inUse && <Badge variant="warning">In use</Badge>}
                    </div>
                    <p className="font-mono-data text-xs text-muted-foreground">{k.fingerprint}</p>
                    <p className="text-xs text-muted-foreground">Added {formatDate(k.created_at)}</p>
                  </div>
                  <ConfirmDialog
                    trigger={
                      <DialogTrigger asChild>
                        <Button variant="danger" size="sm">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </DialogTrigger>
                    }
                    title="Delete this SSH key?"
                    description={
                      inUse
                        ? "This key is currently used by an active rental. Deleting it won't disconnect that rental, but you won't be able to use this key for new connections."
                        : "You won't be able to connect with this key anymore. This can't be undone."
                    }
                    confirmLabel="Delete key"
                    variant="danger"
                    pending={pending}
                    onConfirm={() => handleDelete(k.id)}
                  />
                </div>
              );
            })}
          </div>
        )}

        <div className="rounded-lg border border-dashed border-border p-4">
          <p className="text-xs text-muted-foreground">
            Don't have an SSH key pair? Run this in your terminal, then paste the contents of the .pub file below.
          </p>
          <CopyCommand command="ssh-keygen -t ed25519" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ssh-label">Label</Label>
            <Input id="ssh-label" placeholder="e.g. work laptop" value={label} onChange={(e) => setLabel(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ssh-key">Public key</Label>
            <Textarea
              id="ssh-key"
              rows={3}
              placeholder="ssh-ed25519 AAAA..."
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              className="font-mono-data"
              required
            />
            {validationError && <p className="text-xs text-danger">{validationError}</p>}
          </div>
          <Button type="submit" loading={pending} disabled={!label.trim() || !publicKey.trim() || !!validationError}>
            <Plus className="h-4 w-4" />
            Add SSH key
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function AccountSection({ email }: { email: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Account</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{email}</p>
          <p className="text-xs text-muted-foreground">Rental times are shown in your browser's local timezone.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => signOut({ redirectTo: "/" })}>
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </Button>
      </CardContent>
    </Card>
  );
}
