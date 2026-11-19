"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  Copy,
  Cpu,
  FolderOpen,
  HardDrive,
  Image,
  KeyRound,
  Play,
  Terminal,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { useAction } from "@/lib/hooks/use-action";
import { formatGbp, formatDateTime } from "@/lib/utils";
import {
  deleteWorkspaceAction,
  resizeWorkspaceAction,
  buyPrepaidAction,
  attachWorkspaceSshKeyAction,
  startWorkspaceGpuAction,
} from "./workspaces-actions";
import { WorkspaceWizard } from "./workspace-wizard";
import { GpuPicker, assessGpu, defaultGpuSelection, type GpuSelection } from "./gpu-picker";
import type { GpuSku, ImageCatalogueEntry, PlanCode, SshKey } from "@/lib/compute-types";
import type { StorageCatalogueSize, Workspace, WorkspaceSlots } from "@/lib/workspaces-client";

const BILLING_LABEL: Record<Workspace["billing_mode"], string> = {
  HOURLY: "Hourly metered",
  PREPAID_30D: "Prepaid 30 days",
};

/** The active rental's connection facts (from GET /compute/rentals). */
export type ActiveRentalInfo = {
  public_ip: string | null;
  region_code: string | null;
  status: string;
};

/** Amazon Linux images log in as ec2-user, Ubuntu images as ubuntu. */
function sshUserFor(imageDisplayName: string | null): string {
  return (imageDisplayName ?? "").toLowerCase().includes("ubuntu") ? "ubuntu" : "ec2-user";
}

export function WorkspacesSection({
  workspaces,
  slots,
  storageSizes,
  sshKeys,
  plan,
  gpuTypes,
  images,
  concurrentUsed,
  walletBalanceMicros,
  activeRentalByWorkspace,
}: {
  workspaces: Workspace[];
  slots: WorkspaceSlots;
  storageSizes: StorageCatalogueSize[];
  sshKeys: SshKey[];
  plan: PlanCode;
  gpuTypes: GpuSku[];
  images: ImageCatalogueEntry[];
  concurrentUsed: number;
  walletBalanceMicros: number;
  activeRentalByWorkspace: Record<string, ActiveRentalInfo>;
}) {
  const { pending, run } = useAction();
  const atSlotLimit = slots.used >= slots.included;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {slots.used} of {slots.included} workspace slot{slots.included === 1 ? "" : "s"} used ({plan} plan) ·
          pick the GPU in setup — Taskflow boots it on AWS and billing starts when it runs
        </p>
        <WorkspaceWizard
          storageSizes={storageSizes}
          sshKeys={sshKeys}
          gpuTypes={gpuTypes}
          images={images}
          plan={plan}
          concurrentUsed={concurrentUsed}
          walletBalanceMicros={walletBalanceMicros}
          disabled={atSlotLimit || pending}
        />
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
          description="A workspace is your machine: name it, give it storage, pick its GPU and image — Taskflow boots it on AWS and starts billing."
          action={
            <WorkspaceWizard
              storageSizes={storageSizes}
              sshKeys={sshKeys}
              gpuTypes={gpuTypes}
              images={images}
              plan={plan}
              concurrentUsed={concurrentUsed}
              walletBalanceMicros={walletBalanceMicros}
              disabled={atSlotLimit}
              trigger={<Button>Create your first workspace</Button>}
            />
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {workspaces.map((ws) => (
            <WorkspaceCard
              key={ws.id}
              ws={ws}
              storageSizes={storageSizes}
              sshKeys={sshKeys}
              gpuTypes={gpuTypes}
              plan={plan}
              concurrentUsed={concurrentUsed}
              walletBalanceMicros={walletBalanceMicros}
              activeRental={activeRentalByWorkspace[ws.id] ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceCard({
  ws,
  storageSizes,
  sshKeys,
  gpuTypes,
  plan,
  concurrentUsed,
  walletBalanceMicros,
  activeRental,
}: {
  ws: Workspace;
  storageSizes: StorageCatalogueSize[];
  sshKeys: SshKey[];
  gpuTypes: GpuSku[];
  plan: PlanCode;
  concurrentUsed: number;
  walletBalanceMicros: number;
  activeRental: ActiveRentalInfo | null;
}) {
  const { pending, run } = useAction();
  const [sizeOpen, setSizeOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [gpuOpen, setGpuOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newSize, setNewSize] = useState(ws.storage_size_gb);
  const [newKeyId, setNewKeyId] = useState("");
  const [selection, setSelection] = useState<GpuSelection>(() => defaultGpuSelection(gpuTypes, plan, concurrentUsed));

  const sizeRow = storageSizes.find((s) => s.size_gb === ws.storage_size_gb);
  const canPrepaid = ws.billing_mode === "HOURLY" && !ws.is_included && sizeRow?.prepaid_price_micros != null;
  const hasGpu = ws.active_gpu_count > 0;
  const assessment = assessGpu({
    gpuTypes,
    value: selection,
    plan,
    concurrentUsed,
    walletBalanceMicros,
    storageGb: ws.storage_size_gb,
  });
  const startBlocked =
    assessment.sku === null || assessment.blockReason !== null || !ws.ssh_key_label;

  const publicIp = activeRental?.public_ip ?? null;
  const sshUser = sshUserFor(ws.image_display_name);
  const sshCommand = publicIp
    ? `ssh -i <your-key-file> ${sshUser}@${publicIp}`
    : `ssh -i <your-key-file> ${sshUser}@<public-ip>`;

  async function copySshCommand() {
    try {
      await navigator.clipboard.writeText(sshCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Couldn't copy to clipboard", variant: "danger" });
    }
  }

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
              {ws.image_display_name && ` · ${ws.image_display_name}`}
            </CardDescription>
          </div>
          {hasGpu && (
            <Badge variant="success">
              <Cpu className="h-3 w-3" />
              {ws.active_gpu_count > 1 ? `${ws.active_gpu_count} GPUs attached` : "GPU attached"}
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
          {ws.image_display_name && (
            <span className="flex items-center gap-1">
              <Image className="h-3.5 w-3.5" />
              {ws.image_display_name}
            </span>
          )}
          {ws.total_charged_micros > 0 && (
            <span className="font-mono-data">{formatGbp(ws.total_charged_micros, { precise: true })} billed so far</span>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {/* ---- Start GPU: the workspace is the machine — boot it here ---- */}
          {!hasGpu && (
            <Dialog open={gpuOpen} onOpenChange={setGpuOpen}>
              <Button size="sm" onClick={() => setGpuOpen(true)}>
                <Play className="h-3.5 w-3.5" />
                Start GPU
              </Button>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Start GPU — {ws.name}</DialogTitle>
                  <DialogDescription>
                    {ws.storage_display_name} storage · boots on AWS right away · billed hourly from your wallet while
                    it runs.
                  </DialogDescription>
                </DialogHeader>

                <GpuPicker
                  gpuTypes={gpuTypes}
                  value={selection}
                  onChange={setSelection}
                  plan={plan}
                  concurrentUsed={concurrentUsed}
                  walletBalanceMicros={walletBalanceMicros}
                  storageGb={ws.storage_size_gb}
                />

                {!ws.ssh_key_label && (
                  <p className="flex items-start gap-1.5 text-sm text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    This workspace has no SSH key yet — attach one first. A machine you can&apos;t reach must never
                    bill you.
                  </p>
                )}

                <DialogFooter className="items-center">
                  <Button
                    loading={pending}
                    disabled={startBlocked}
                    onClick={() =>
                      run(
                        () =>
                          startWorkspaceGpuAction(ws.id, {
                            gpu_type_slug: assessment.sku!.slug,
                            quantity: assessment.quantity,
                            payment_mode: selection.paymentMode,
                            location_preference: selection.location,
                            ...(selection.paymentMode === "booking"
                              ? { booking_duration: selection.duration }
                              : {}),
                          }),
                        {
                          success:
                            selection.paymentMode === "booking"
                              ? "Redirecting to checkout…"
                              : `Starting ${assessment.quantity} × ${assessment.sku?.display_name}…`,
                          error: "Couldn't start the GPU",
                          onSuccess: (res) => {
                            setGpuOpen(false);
                            if (res.checkout_url) window.location.assign(res.checkout_url);
                          },
                        }
                      )
                    }
                  >
                    {assessment.sku
                      ? selection.paymentMode === "pay_as_you_go"
                        ? `Start ${assessment.quantity > 1 ? `${assessment.quantity} × ` : ""}${assessment.sku.display_name} · ${formatGbp(assessment.hourlyTotalMicros)}/hr`
                        : "Book GPU"
                      : "Start GPU"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}

          {/* ---- Connect: branded SSH instructions ---- */}
          {hasGpu && (
            <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
              <Button variant="secondary" size="sm" onClick={() => setConnectOpen(true)}>
                <Terminal className="h-3.5 w-3.5" />
                Connect
              </Button>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Terminal className="h-4 w-4" />
                    Connect to {ws.name}
                  </DialogTitle>
                  <DialogDescription>
                    {publicIp
                      ? `Public IP ${publicIp}${activeRental?.region_code ? ` · ${activeRental.region_code}` : ""}`
                      : "Waiting for the machine to get a public IP…"}
                  </DialogDescription>
                </DialogHeader>

                {/* Branded terminal preview — exactly what they'll see on login */}
                <div className="overflow-hidden rounded-md border border-border bg-foreground/5">
                  <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                    <span className="h-2 w-2 rounded-full bg-danger/60" />
                    <span className="h-2 w-2 rounded-full bg-warning/60" />
                    <span className="h-2 w-2 rounded-full bg-success/60" />
                    <span className="ml-1">ssh · {ws.name}</span>
                  </div>
                  <pre className="overflow-x-auto px-3 py-2.5 font-mono-data text-xs leading-relaxed">
                    {`──────────────────────────────────────
 Taskflow workspace: ${ws.name}
 Region:  ${activeRental?.region_code ?? "—"}   Image: ${ws.image_display_name ?? "platform default"}
──────────────────────────────────────
Taskflow$: ${ws.name} ~ $ `}
                  </pre>
                </div>

                <div className="rounded-md border border-border bg-muted/30 p-3">
                  <p className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                    <span>SSH command</span>
                    <button
                      onClick={copySshCommand}
                      className="flex items-center gap-1 transition-colors hover:text-foreground"
                    >
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </p>
                  <p className="break-all font-mono-data text-xs">{sshCommand}</p>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    Use the private half of {ws.ssh_key_label ? `"${ws.ssh_key_label}"` : "this workspace's key"} (the
                    file you downloaded at creation). The prompt above is Taskflow&apos;s branded shell.
                  </p>
                </div>

                {!publicIp && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Cpu className="h-3.5 w-3.5" />
                    The public IP appears as soon as the GPU finishes booting — usually within a couple of minutes.
                  </p>
                )}

                <DialogFooter>
                  <Button variant="secondary" onClick={() => setConnectOpen(false)}>
                    Close
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}

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
                  This key is provisioned to every GPU launched from this workspace — required before a GPU can start.
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
              <Button variant="danger" size="sm" disabled={hasGpu}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            }
            title="Delete this workspace?"
            description="Storage and its SSH attachment are removed permanently. A running GPU attached to this workspace must be released first."
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
