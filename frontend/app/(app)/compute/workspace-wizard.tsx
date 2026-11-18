"use client";

import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  KeyRound,
  Plus,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { formatGbp } from "@/lib/utils";
import { validatePublicKey } from "@/lib/ssh-key-validation";
import { createWorkspaceAction } from "./workspaces-actions";
import { addSshKeyAction, deleteSshKeyAction, generateSshKeyAction } from "./ssh-actions";
import type { GeneratedSshKey } from "@/lib/ssh-keys-client";
import type { SshKey } from "@/lib/compute-types";
import type { StorageCatalogueSize } from "@/lib/workspaces-client";

// Guided workspace creation: one decision per step (name → storage → billing
// → SSH key → review). When the key is generated server-side the last step is
// a one-time download prompt (.json / .txt) — the private key exists nowhere
// else, so this dialog is its only chance to be saved.

const STEP_TITLES = ["Name", "Storage", "Billing", "SSH key", "Review"] as const;
const DOWNLOAD_STEP = STEP_TITLES.length; // 5

type SshMode = "generate" | "existing" | "paste" | "none";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function keyPairJson(workspaceName: string, key: GeneratedSshKey): string {
  return (
    JSON.stringify(
      {
        workspace: workspaceName,
        label: key.label,
        fingerprint: key.fingerprint,
        created_at: key.created_at,
        public_key: key.public_key.trim(),
        private_key: key.private_key.trim(),
      },
      null,
      2
    ) + "\n"
  );
}

function keyPairTxt(workspaceName: string, key: GeneratedSshKey): string {
  return [
    "Taskflow SSH key pair",
    `Workspace:  ${workspaceName}`,
    `Label:      ${key.label}`,
    `Fingerprint:${key.fingerprint.startsWith("SHA256:") ? " " : " "}${key.fingerprint}`,
    `Created:    ${key.created_at}`,
    "",
    "# Public key (safe to share)",
    key.public_key.trim(),
    "",
    "# Private key — keep secret, never share it",
    key.private_key.trim(),
    "",
  ].join("\n");
}

export function WorkspaceWizard({
  storageSizes,
  sshKeys,
  disabled,
  trigger,
}: {
  storageSizes: StorageCatalogueSize[];
  sshKeys: SshKey[];
  disabled?: boolean;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [sizeGb, setSizeGb] = useState(storageSizes[0]?.size_gb ?? 0);
  const [billing, setBilling] = useState<"hourly" | "prepaid_30d">("hourly");
  const [sshMode, setSshMode] = useState<SshMode>("generate");
  const [existingKeyId, setExistingKeyId] = useState("");
  const [pastedKey, setPastedKey] = useState("");
  const [createdKey, setCreatedKey] = useState<GeneratedSshKey | null>(null);
  const [createdWorkspaceName, setCreatedWorkspaceName] = useState("");
  const [copied, setCopied] = useState(false);

  const selectedSize = storageSizes.find((s) => s.size_gb === sizeGb) ?? null;
  const isIncluded = !!selectedSize?.is_included;
  const prepaidAvailable = !!selectedSize?.prepaid_price_micros;
  const pasteError = pastedKey.trim() ? validatePublicKey(pastedKey) : "Paste your public key to continue.";

  const stepValid =
    step === 0
      ? name.trim().length > 0
      : step === 1
        ? sizeGb > 0 && storageSizes.length > 0
        : step === 2
          ? true
          : step === 3
            ? sshMode === "generate" || sshMode === "none"
              ? true
              : sshMode === "existing"
                ? existingKeyId !== ""
                : pasteError === null
            : true;

  function reset() {
    setStep(0);
    setName("");
    setSizeGb(storageSizes[0]?.size_gb ?? 0);
    setBilling("hourly");
    setSshMode("generate");
    setExistingKeyId("");
    setPastedKey("");
    setCreatedKey(null);
    setCreatedWorkspaceName("");
    setCopied(false);
    setPending(false);
  }

  function closeAndReset() {
    setOpen(false);
    reset();
  }

  async function handleCreate() {
    if (pending) return;
    setPending(true);
    let generated: GeneratedSshKey | null = null;
    try {
      let sshKeyId: string | undefined;
      if (sshMode === "generate") {
        generated = await generateSshKeyAction(`${name.trim()} key`);
        sshKeyId = generated.id;
      } else if (sshMode === "existing" && existingKeyId) {
        sshKeyId = existingKeyId;
      } else if (sshMode === "paste") {
        const error = validatePublicKey(pastedKey);
        if (error) throw new Error(error);
        const key = await addSshKeyAction(`${name.trim()} key`, pastedKey.trim());
        sshKeyId = key.id;
      }

      await createWorkspaceAction({
        name: name.trim(),
        storage_size_gb: sizeGb,
        billing_mode: isIncluded ? "hourly" : billing,
        ...(sshKeyId ? { ssh_key_id: sshKeyId } : {}),
      });

      toast({ title: `Workspace "${name.trim()}" created`, variant: "success" });
      if (generated) {
        setCreatedWorkspaceName(name.trim());
        setCreatedKey(generated);
        setStep(DOWNLOAD_STEP);
      } else {
        closeAndReset();
      }
    } catch (err) {
      // The workspace didn't exist — a key generated for it is orphaned.
      // Remove it best-effort so the account doesn't accumulate dead keys.
      if (generated) {
        try {
          await deleteSshKeyAction(generated.id);
        } catch {
          /* best effort */
        }
      }
      toast({
        title: "Couldn't create the workspace",
        description: err instanceof Error ? err.message : undefined,
        variant: "danger",
      });
    } finally {
      setPending(false);
    }
  }

  function downloadKey(format: "json" | "txt") {
    if (!createdKey) return;
    const base = `${slugify(createdWorkspaceName)}-ssh-key`;
    if (format === "json") {
      downloadText(`${base}.json`, keyPairJson(createdWorkspaceName, createdKey), "application/json");
    } else {
      downloadText(`${base}.txt`, keyPairTxt(createdWorkspaceName, createdKey), "text/plain");
    }
  }

  async function copyPublicKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.public_key.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Couldn't copy to clipboard", variant: "danger" });
    }
  }

  const sshSummary =
    sshMode === "generate"
      ? "A new ed25519 key pair will be generated — you'll download it right after creation"
      : sshMode === "existing"
        ? (() => {
            const key = sshKeys.find((k) => k.id === existingKeyId);
            return key ? `${key.label} (${key.fingerprint})` : "Existing key";
          })()
        : sshMode === "paste"
          ? "Your own public key"
          : "No SSH key — you can attach one later";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button disabled={disabled}>
            <Plus className="h-4 w-4" />
            New workspace
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        {step < DOWNLOAD_STEP ? (
          <>
            <DialogHeader>
              <DialogTitle>Create a workspace</DialogTitle>
              <DialogDescription>
                Step {step + 1} of {STEP_TITLES.length} · {STEP_TITLES[step]}
              </DialogDescription>
            </DialogHeader>

            {/* Progress */}
            <div className="flex gap-1.5" aria-hidden>
              {STEP_TITLES.map((title, i) => (
                <div key={title} className="flex-1">
                  <div className={`h-1 rounded-full transition-colors ${i <= step ? "bg-primary" : "bg-muted"}`} />
                  <p className={`mt-1.5 text-[10px] ${i === step ? "text-foreground" : "text-muted-foreground"}`}>
                    {title}
                  </p>
                </div>
              ))}
            </div>

            <div className="min-h-44 space-y-4 pt-1">
              {step === 0 && (
                <div className="space-y-2">
                  <Label htmlFor="ws-name">Workspace name</Label>
                  <Input
                    id="ws-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. training-data"
                    maxLength={60}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && stepValid) setStep(1);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    A persistent environment that keeps storage and its SSH identity between GPU rentals.
                  </p>
                </div>
              )}

              {step === 1 && (
                <div className="space-y-2">
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
                          {s.is_included
                            ? "Included with your plan"
                            : s.hourly_price_micros > 0
                              ? `${formatGbp(s.hourly_price_micros)}/hr`
                              : "Free"}
                        </span>
                      </button>
                    ))}
                  </div>
                  {storageSizes.length === 0 && (
                    <p className="text-xs text-warning">No storage sizes are currently available for your plan.</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    The size matching your plan is included and never billed. You can resize later.
                  </p>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-2">
                  <Label>Billing</Label>
                  {isIncluded ? (
                    <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                      <p className="flex items-center gap-2 font-medium">
                        <Check className="h-4 w-4 text-success" />
                        {selectedSize?.display_name} is included with your plan
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        No storage charge — only GPU time and extra storage beyond your plan are billed.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
                        <button
                          onClick={() => setBilling("hourly")}
                          className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                            billing === "hourly" ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          Hourly
                        </button>
                        {prepaidAvailable && (
                          <button
                            onClick={() => setBilling("prepaid_30d")}
                            className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
                              billing === "prepaid_30d" ? "bg-card panel-edge text-foreground" : "text-muted-foreground"
                            }`}
                          >
                            Prepaid 30d · {formatGbp(selectedSize!.prepaid_price_micros!)}
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {billing === "hourly"
                          ? "Billed hourly from your wallet while the workspace exists — GPU running or not."
                          : "One-off 30-day commitment from your wallet; reverts to hourly at expiry. Data is never deleted at expiry."}
                      </p>
                    </>
                  )}
                </div>
              )}

              {step === 3 && (
                <div className="space-y-3">
                  <Label>SSH key</Label>
                  <div className="space-y-2">
                    <SshOption
                      selected={sshMode === "generate"}
                      onSelect={() => setSshMode("generate")}
                      icon={<Sparkles className="h-4 w-4" />}
                      title="Generate a new key pair"
                      description="Ed25519 key created for this workspace — download it as .json or .txt after creation."
                      badge={<Badge variant="accent">Recommended</Badge>}
                    />
                    {sshKeys.length > 0 && (
                      <SshOption
                        selected={sshMode === "existing"}
                        onSelect={() => setSshMode("existing")}
                        icon={<KeyRound className="h-4 w-4" />}
                        title="Use a saved key"
                        description="Attach one of the SSH keys already on your account."
                      />
                    )}
                    <SshOption
                      selected={sshMode === "paste"}
                      onSelect={() => setSshMode("paste")}
                      icon={<Copy className="h-4 w-4" />}
                      title="Paste your own public key"
                      description="The contents of your id_ed25519.pub / id_rsa.pub file."
                    />
                    <SshOption
                      selected={sshMode === "none"}
                      onSelect={() => setSshMode("none")}
                      icon={<AlertTriangle className="h-4 w-4" />}
                      title="No SSH key for now"
                      description="You can attach a key to this workspace later."
                    />
                  </div>

                  {sshMode === "existing" && (
                    <select
                      value={existingKeyId}
                      onChange={(e) => setExistingKeyId(e.target.value)}
                      className="h-10 w-full rounded-md border border-border bg-muted/40 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    >
                      <option value="">Choose a key…</option>
                      {sshKeys.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label} ({k.fingerprint})
                        </option>
                      ))}
                    </select>
                  )}

                  {sshMode === "paste" && (
                    <div className="space-y-1.5">
                      <Textarea
                        value={pastedKey}
                        onChange={(e) => setPastedKey(e.target.value)}
                        placeholder="ssh-ed25519 AAAA… user@laptop"
                        rows={3}
                      />
                      {pastedKey.trim() && pasteError && <p className="text-xs text-warning">{pasteError}</p>}
                      {pasteError === null && (
                        <p className="flex items-center gap-1 text-xs text-success">
                          <Check className="h-3.5 w-3.5" />
                          Looks like a valid public key.
                        </p>
                      )}
                    </div>
                  )}

                  <p className="text-xs text-muted-foreground">
                    The key is provisioned to every GPU rental launched from this workspace.
                  </p>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-2">
                  <Label>Review</Label>
                  <dl className="divide-y divide-border rounded-md border border-border">
                    <ReviewRow label="Name" value={name.trim()} />
                    <ReviewRow
                      label="Storage"
                      value={
                        selectedSize
                          ? `${selectedSize.display_name} · ${
                              selectedSize.is_included
                                ? "included with plan"
                                : selectedSize.hourly_price_micros > 0
                                  ? `${formatGbp(selectedSize.hourly_price_micros)}/hr`
                                  : "free"
                            }`
                          : `${sizeGb} GB`
                      }
                    />
                    <ReviewRow
                      label="Billing"
                      value={isIncluded ? "No storage charge (plan included)" : billing === "hourly" ? "Hourly metered" : "Prepaid 30 days"}
                    />
                    <ReviewRow label="SSH key" value={sshSummary} />
                  </dl>
                  {sshMode === "generate" && (
                    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                      <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      After creation you&apos;ll be prompted to download the key pair — the private key is shown only
                      once and is never stored on our servers.
                    </p>
                  )}
                </div>
              )}
            </div>

            <DialogFooter className="items-center">
              {step > 0 && (
                <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={pending}>
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </Button>
              )}
              {step < 4 ? (
                <Button onClick={() => setStep((s) => s + 1)} disabled={!stepValid || pending}>
                  Next
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button onClick={handleCreate} loading={pending}>
                  Create workspace
                </Button>
              )}
            </DialogFooter>
          </>
        ) : (
          /* --------- One-time SSH key download (post-creation) --------- */
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                Workspace created — save your SSH key
              </DialogTitle>
              <DialogDescription>
                &ldquo;{createdWorkspaceName}&rdquo; is ready. This is the only time the private key will be shown —
                download it now.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                The private key is never stored on our servers. If you lose it you&apos;ll need to attach a different
                key to the workspace.
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Button variant="secondary" onClick={() => downloadKey("json")}>
                  <Download className="h-4 w-4" />
                  Download .json
                </Button>
                <Button variant="secondary" onClick={() => downloadKey("txt")}>
                  <Download className="h-4 w-4" />
                  Download .txt
                </Button>
              </div>

              <div className="rounded-md border border-border bg-muted/30 p-3">
                <p className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Public key</span>
                  <button
                    onClick={copyPublicKey}
                    className="flex items-center gap-1 transition-colors hover:text-foreground"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </p>
                <p className="break-all font-mono-data text-xs">{createdKey?.public_key.trim()}</p>
                <p className="mt-1.5 text-[11px] text-muted-foreground">Fingerprint: {createdKey?.fingerprint}</p>
              </div>
            </div>

            <DialogFooter>
              <Button onClick={closeAndReset}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SshOption({
  selected,
  onSelect,
  icon,
  title,
  description,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  description: string;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors ${
        selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
      }`}
    >
      <span className={`mt-0.5 ${selected ? "text-primary" : "text-muted-foreground"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <span
        className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border ${
          selected ? "border-primary bg-primary" : "border-border"
        }`}
      />
    </button>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
