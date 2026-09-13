"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Cpu, Copy, Check, Square, Play, Trash2, AlertTriangle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, StatusDot } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogTrigger } from "@/components/ui/dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatGbp, formatDateTime } from "@/lib/utils";
import type { Rental, GpuTier, RentalStatus } from "@/lib/compute-types";
import { stopRentalAction, startRentalAction, terminateRentalAction } from "./actions";

const STATUS_META: Record<RentalStatus, { label: string; variant: "warning" | "success" | "default" | "danger" | "outline"; pulse?: boolean }> = {
  PROVISIONING: { label: "Provisioning", variant: "warning", pulse: true },
  RUNNING: { label: "Running", variant: "success" },
  STOPPED: { label: "Stopped", variant: "default" },
  TERMINATING: { label: "Terminating", variant: "warning", pulse: true },
  TERMINATED: { label: "Terminated", variant: "outline" },
  FAILED: { label: "Failed", variant: "danger" },
};

function elapsedLabel(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function remainingLabel(expiresAt: string, now: number): { label: string; warn: boolean } {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return { label: "Expired", warn: true };
  const totalMinutes = Math.floor(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return { label: h > 0 ? `${h}h ${m}m left` : `${m}m left`, warn: ms < 60 * 60 * 1000 };
}

function CopySsh({ publicIp }: { publicIp: string }) {
  const [copied, setCopied] = useState(false);
  const command = `ssh ubuntu@${publicIp}`;
  return (
    <div className="mt-3 flex items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
      <code className="font-mono-data text-xs">{command}</code>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function RentalCard({ rental, tier, now }: { rental: Rental; tier: GpuTier | undefined; now: number }) {
  const { pending, run } = useAction();
  const meta = STATUS_META[rental.status];

  const remaining = rental.booking_expires_at ? remainingLabel(rental.booking_expires_at, now) : null;

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-medium">
                {tier?.display_name ?? rental.gpu_type_slug} · {rental.storage_gb}GB
              </p>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <Badge variant={meta.variant}>
                <StatusDot variant={meta.variant} className={meta.pulse ? "animate-pulse" : undefined} />
                {meta.label}
              </Badge>
              {rental.status === "PROVISIONING" && <span className="text-xs text-muted-foreground">Setting up — this takes 1-2 minutes</span>}
              {rental.status === "RUNNING" && rental.started_at && (
                <span className="font-mono-data text-xs text-muted-foreground">up {elapsedLabel(rental.started_at, now)}</span>
              )}
            </div>
          </div>

          <div className="text-right">
            {rental.payment_mode === "pay_as_you_go" && rental.accrued_cost_micros !== null && (
              <p className="font-mono-data text-sm font-medium">{formatGbp(rental.accrued_cost_micros, { precise: true })}</p>
            )}
            {remaining && (
              <p className={`font-mono-data text-sm font-medium ${remaining.warn ? "text-warning" : ""}`}>{remaining.label}</p>
            )}
          </div>
        </div>

        {remaining?.warn && rental.status === "RUNNING" && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5 text-warning">
              <AlertTriangle className="h-3.5 w-3.5" />
              This booking expires soon — the instance auto-terminates at the end of the period.
            </span>
            <Button size="sm" variant="outline" disabled>
              Extend booking
            </Button>
          </div>
        )}

        {rental.status === "RUNNING" && rental.public_ip && (
          <>
            <CopySsh publicIp={rental.public_ip} />
            {rental.ssh_key_label && <p className="mt-1.5 text-xs text-muted-foreground">Using key: {rental.ssh_key_label}</p>}
          </>
        )}

        {rental.status === "FAILED" && rental.error_detail && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {rental.error_detail}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {rental.status === "RUNNING" && (
            <>
              <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => stopRentalAction(rental.id), { success: "Rental stopped" })}>
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
              <ConfirmDialog
                trigger={
                  <DialogTrigger asChild>
                    <Button variant="danger" size="sm">
                      <Trash2 className="h-3.5 w-3.5" />
                      Terminate
                    </Button>
                  </DialogTrigger>
                }
                title="Terminate this rental?"
                description="This permanently deletes the instance and any data on it. This can't be undone."
                confirmLabel="Terminate"
                variant="danger"
                pending={pending}
                onConfirm={() => run(() => terminateRentalAction(rental.id), { success: "Rental terminated" })}
              />
            </>
          )}
          {rental.status === "STOPPED" && (
            <>
              <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => startRentalAction(rental.id), { success: "Rental starting…" })}>
                <Play className="h-3.5 w-3.5" />
                Start
              </Button>
              <ConfirmDialog
                trigger={
                  <DialogTrigger asChild>
                    <Button variant="danger" size="sm">
                      <Trash2 className="h-3.5 w-3.5" />
                      Terminate
                    </Button>
                  </DialogTrigger>
                }
                title="Terminate this rental?"
                description="This permanently deletes the instance and any data on it. This can't be undone."
                confirmLabel="Terminate"
                variant="danger"
                pending={pending}
                onConfirm={() => run(() => terminateRentalAction(rental.id), { success: "Rental terminated" })}
              />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function RentalsList({ rentals, gpuTypes }: { rentals: Rental[]; gpuTypes: GpuTier[] }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());

  const isTransitioning = rentals.some((r) => r.status === "PROVISIONING" || r.status === "TERMINATING");

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!isTransitioning) return;
    const poll = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(poll);
  }, [isTransitioning, router]);

  const tierBySlug = useMemo(() => new Map(gpuTypes.map((t) => [t.slug, t])), [gpuTypes]);

  const active = rentals.filter((r) => r.status !== "TERMINATED" && r.status !== "FAILED");
  const archived = rentals.filter((r) => r.status === "TERMINATED" || r.status === "FAILED");

  if (rentals.length === 0) {
    return (
      <EmptyState
        icon={Cpu}
        title="No GPU rentals yet"
        description="Pick a tier and storage size above, then rent a GPU — it'll show up here once provisioning starts."
      />
    );
  }

  return (
    <div className="space-y-6">
      {active.length > 0 && (
        <div className="space-y-3">
          {active.map((r) => (
            <RentalCard key={r.id} rental={r} tier={tierBySlug.get(r.gpu_type_slug)} now={now} />
          ))}
        </div>
      )}
      {archived.length > 0 && (
        <div>
          <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Past rentals</h3>
          <div className="space-y-3 opacity-70">
            {archived.map((r) => (
              <RentalCard key={r.id} rental={r} tier={tierBySlug.get(r.gpu_type_slug)} now={now} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
