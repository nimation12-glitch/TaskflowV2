"use client";

import { useState } from "react";
import { HardDrive, Plus, KeyRound, AlertTriangle, Cpu, Trash2, CalendarClock, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatGbp, formatDateTime } from "@/lib/utils";
import {
  createWorkspaceAction,
  deleteWorkspaceAction,
  resizeWorkspaceAction,
  buyPrepaidAction,
  attachWorkspaceSshKeyAction,
} from "./actions";
import type { PlanCode } from "@/lib/compute-types";
import type { SshKey } from "@/lib/compute-types";
import type { StorageCatalogueSize, Workspace, WorkspaceSlots } from "@/lib/workspaces-client";

const BILLING_LABEL: Record<Workspace["billing_mode"], string> = {
  HOURLY: "Hourly metered",
  PREPAID_30D: "Prepaid 30 days",
};

export function WorkspacesClient({
  workspaces,
  slots,
  storageSizes,
  sshKeys,
  plan,
}: {
  workspaces: Workspace[];
  slots: WorkspaceSlots;
  storageSizes: StorageCatalogueSize[];
  sshKeys: SshKey[];
  plan: PlanCode;
}) {
  const { pending, run } = useAction();
  const atSlotLimit = slots.used >= slots.included;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {slots.used} of {slots.included} workspace slot{slots.included === 1 ? "" : "s"} used ({plan} plan)
        </p>
        <CreateWorkspaceDialog storageSizes={storageSizes} sshKeys={sshKeys} disabled={atSlotLimit || pending} />
      </div>

      {atSlotLimit && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" />
          You&apos;ve used all {slots.included} workspace slots on your plan. Delete one to free a slot, or upgrade.
        </p>
      )}

      {workspaces.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No workspaces yet"
          description="Create a workspace to get persistent storage and an SSH identity that survive between GPU rentals."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {workspaces.map((ws) => (
            <WorkspaceCard key={ws.id} ws={ws} storageSizes={storageSizes} sshKeys={sshKeys} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateWorkspaceDialog({
  storageSizes,
  sshKeys,
  disabled,
}: {
  storageSizes: StorageCatalogueSize[];
  sshKeys: SshKey[];
  disabled?: boolean;
}) {
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const firstSize = storageSizes[0];
  const [sizeGb, setSizeGb] = useState(firstSize?.size_gb ?? 0);
  const [billing, setBilling] = useState<"hourly" | "prepaid_30d">("hourly");
  const [sshKeyId, setSshKeyId] = useState("");

  const selectedSize = storageSizes.find((s) => s.size_gb === sizeGb);
  const prepaidAvailable = billing === "prepaid_30d" && !!selectedSize?.prepaid_price_micros;
  const canSubmit = name.trim().length > 0 && sizeGb > 0 && !disabled;

  function handleSubmit() {
    if (!canSubmit) return;
    run(
      () =>
        createWorkspaceAction({
          name: name.trim(),
          storage_size_gb: sizeGb,
          billing_mode: billing,
          ...(sshKeyId ? { ssh_key_id: sshKeyId } : {}),
        }),
      { success: `Workspace "${name.trim()}" created`, error: "Couldn't create the workspace", onSuccess: () => setOpen(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={disabled}>
          <Plus className="h-4 w-4" />
          New workspace
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a workspace</DialogTitle>
          <DialogDescription>
            Persistent storage + SSH identity that outlive GPU rentals. The size matching your plan is included and
            never billed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="ws-name">Name</Label>
            <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. training-data" maxLength={60} />
          </div>
          <div>
            <Label>Storage</Label>
            <div className="grid grid-cols-2 gap-2">
              {storageSizes.map((s) => (
                <button
                  key={s.size_gb}
                  onClick={() => setSizeGb(s.size_gb)}
                  className={`rounded-md border p-2.5 text-left text-sm transition-colors ${
                    sizeGb === s.size_gb ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
                  }`}
                >
                  <span className="font-medium">{s.display_name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {s.is_included ? "Included with your plan" : s.hourly_price_micros > 0 ? `${formatGbp(s.hourly_price_micros)}/hr` : "Free"}
                  </span>
                </button>
              ))}
              {storageSizes.length === 0 && (
                <p className="text-xs text-muted-foreground">No storage sizes are currently available for your plan.</p>
              )}
            </div>
          </div>
          {selectedSize && !selectedSize.is_included && (
            <div>
              <Label>Billing</Label>
              <div className="mt-1 inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
                <button
                  onClick={() => setBilling("hourly")}
                  className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                    billing === "hourly" ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
                  }`}
                >
                  Hourly
                </button>
                {selectedSize.prepaid_price_micros !== null && (
                  <button
                    onClick={() => setBilling("prepaid_30d")}
                    className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                      billing === "prepaid_30d" ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    Prepaid 30d · {formatGbp(selectedSize.prepaid_price_micros)}
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {billing === "hourly"
                  ? "Billed hourly from your wallet while the workspace exists — GPU running or not."
                  : "One-off 30-day commitment from your wallet; reverts to hourly at expiry. Data is never deleted at expiry."}
              </p>
            </div>
          )}
          <div>
            <Label htmlFor="ws-ssh">SSH key (optional)</Label>
            <select
              id="ws-ssh"
              value={sshKeyId}
              onChange={(e) => setSshKeyId(e.target.value)}
              className="mt-1 h-10 w-full rounded-md border border-border bg-muted/40 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">None — add later</option>
              {sshKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} ({k.fingerprint})
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} loading={pending} disabled={!canSubmit}>
            Create workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceCard({
  ws,
  storageSizes,
  sshKeys,
}: {
  ws: Workspace;
  storageSizes: StorageCatalogueSize[];
  sshKeys: SshKey[];
}) {
  const { pending, run } = useAction();
  const [sizeOpen, setSizeOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [newSize, setNewSize] = useState(ws.storage_size_gb);
  const [newKeyId, setNewKeyId] = useState("");

  const sizeRow = storageSizes.find((s) => s.size_gb === ws.storage_size_gb);
  const canPrepaid = ws.billing_mode === "HOURLY" && !ws.is_included && sizeRow?.prepaid_price_micros != null;
  const hasActiveRental = ws.active_gpu_instance_id !== null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <HardDrive className="h-4 w-4" />
              {ws.name}
            </CardTitle>
            <CardDescription>
              {ws.storage_display_name} · {ws.is_included ? "Included with plan" : BILLING_LABEL[ws.billing_mode]}
            </CardDescription>
          </div>
          {hasActiveRental && (
            <Badge variant="success">
              <Cpu className="h-3 w-3" />
              GPU attached
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {ws.payment_overdue && (
          <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Storage payment is overdue (wallet ran out). Top up your wallet — the workspace is never auto-deleted, but
            billing keeps accruing.
          </p>
        )}
        {ws.billing_mode === "PREPAID_30D" && ws.prepaid_expires_at && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            Prepaid until {formatDateTime(ws.prepaid_expires_at)} — reverts to hourly metering after expiry.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <KeyRound className="h-3.5 w-3.5" />
            {ws.ssh_key_label ? `Key: ${ws.ssh_key_label}` : "No SSH key attached"}
          </span>
          {ws.total_charged_micros > 0 && (
            <span className="font-mono-data">{formatGbp(ws.total_charged_micros, { precise: true })} billed so far</span>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {!ws.is_included && (
            <Dialog open={sizeOpen} onOpenChange={setSizeOpen}>
              <Button variant="secondary" size="sm" onClick={() => setSizeOpen(true)}>
                Resize
              </Button>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Resize storage</DialogTitle>
                  <DialogDescription>
                    Billing switches to the new size&apos;s hourly rate immediately. Shrinking keeps your files — make
                    sure they fit.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid grid-cols-2 gap-2">
                  {storageSizes.map((s) => (
                    <button
                      key={s.size_gb}
                      onClick={() => setNewSize(s.size_gb)}
                      className={`rounded-md border p-2.5 text-left text-sm transition-colors ${
                        newSize === s.size_gb ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
                      }`}
                    >
                      <span className="font-medium">{s.display_name}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {s.is_included ? "Included" : s.hourly_price_micros > 0 ? `${formatGbp(s.hourly_price_micros)}/hr` : "Free"}
                      </span>
                    </button>
                  ))}
                </div>
                <DialogFooter>
                  <Button
                    loading={pending}
                    disabled={newSize === ws.storage_size_gb}
                    onClick={() =>
                      run(() => resizeWorkspaceAction(ws.id, newSize), {
                        success: "Workspace resized",
                        error: "Couldn't resize the workspace",
                        onSuccess: () => setSizeOpen(false),
                      })
                    }
                  >
                    Apply new size
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}

          {canPrepaid && (
            <Button
              variant="secondary"
              size="sm"
              loading={pending}
              onClick={() =>
                run(() => buyPrepaidAction(ws.id), {
                  success: `30 days prepaid — ${formatGbp(sizeRow!.prepaid_price_micros!)} drawn from your wallet`,
                  error: "Couldn't buy the prepaid period — check your wallet balance",
                })
              }
            >
              Prepay 30 days ({formatGbp(sizeRow!.prepaid_price_micros!)})
            </Button>
          )}

          <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
            <Button variant="secondary" size="sm" onClick={() => setKeyOpen(true)}>
              {ws.ssh_key_label ? "Change key" : "Attach key"}
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Attach an SSH key</DialogTitle>
                <DialogDescription>
                  This key is provisioned to any GPU rental launched from this workspace.
                </DialogDescription>
              </DialogHeader>
              <select
                value={newKeyId}
                onChange={(e) => setNewKeyId(e.target.value)}
                className="h-10 w-full rounded-md border border-border bg-muted/40 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="">Choose a key…</option>
                {sshKeys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label} ({k.fingerprint})
                  </option>
                ))}
              </select>
              <DialogFooter>
                <Button
                  loading={pending}
                  disabled={!newKeyId}
                  onClick={() =>
                    run(() => attachWorkspaceSshKeyAction(ws.id, newKeyId), {
                      success: "SSH key attached",
                      error: "Couldn't attach that key",
                      onSuccess: () => setKeyOpen(false),
                    })
                  }
                >
                  Attach
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <ConfirmDialog
            trigger={
              <Button variant="danger" size="sm" disabled={hasActiveRental}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            }
            title="Delete this workspace?"
            description="Storage and its SSH attachment are removed permanently. A GPU rental attached to this workspace must be released first."
            confirmLabel="Delete workspace"
            variant="danger"
            pending={pending}
            onConfirm={() => run(() => deleteWorkspaceAction(ws.id), { success: "Workspace deleted", error: "Couldn't delete the workspace" })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
