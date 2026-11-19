"use client";

import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Cpu,
  Download,
  Image,
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
import { GpuPicker, assessGpu, defaultGpuSelection, type GpuSelection } from "./gpu-picker";
import type { GeneratedSshKey } from "@/lib/ssh-keys-client";
import type { GpuSku, ImageCatalogueEntry, PlanCode, SshKey } from "@/lib/compute-types";
import type { StorageCatalogueSize } from "@/lib/workspaces-client";

// Guided workspace creation — the rent flow: a workspace IS the machine, so
// setup picks the GPU and the machine image, and Create boots it on AWS and
// starts billing. One decision per step:
//   Name → Storage → GPU → Image → Billing → SSH key → Review
// When the key is generated server-side the last step is a one-time download
// prompt (.json / .txt) — the private key exists nowhere else, so this dialog
// is its only chance to be saved.

const STEP_TITLES = ["Name", "Storage", "GPU", "Image", "Billing", "SSH key", "Review"] as const;
const DOWNLOAD_STEP = STEP_TITLES.length; // 7

type SshMode = "generate" | "existing" | "paste" | "none";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function defaultImageSlug(list: ImageCatalogueEntry[]): string {
  return list.find((i) => i.is_default)?.slug ?? list[0]?.slug ?? "";
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
  gpuTypes,
  images,
  plan,
  concurrentUsed,
  walletBalanceMicros,
  disabled,
  trigger,
}: {
  storageSizes: StorageCatalogueSize[];
  sshKeys: SshKey[];
  gpuTypes: GpuSku[];
  images: ImageCatalogueEntry[];
  plan: PlanCode;
  concurrentUsed: number;
  walletBalanceMicros: number;
  disabled?: boolean;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [sizeGb, setSizeGb] = useState(storageSizes[0]?.size_gb ?? 0);
  const [billing, setBilling] = useState<"hourly" | "prepaid_30d">("hourly");
  const [gpu, setGpu] = useState<GpuSelection>(() => defaultGpuSelection(gpuTypes, plan, concurrentUsed));
  const [imageSlug, setImageSlug] = useState(() => defaultImageSlug(images));
  const [sshMode, setSshMode] = useState<SshMode>("generate");
  const [existingKeyId, setExistingKeyId] = useState("");
  const [pastedKey, setPastedKey] = useState("");
  const [createdKey, setCreatedKey] = useState<GeneratedSshKey | null>(null);
  const [createdWorkspaceName, setCreatedWorkspaceName] = useState("");
  const [pendingCheckoutUrl, setPendingCheckoutUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const selectedSize = storageSizes.find((s) => s.size_gb === sizeGb) ?? null;
  const isIncluded = !!selectedSize?.is_included;
  const prepaidAvailable = !!selectedSize?.prepaid_price_micros;
  const pasteError = pastedKey.trim() ? validatePublicKey(pastedKey) : "Paste your public key to continue.";

  // The money picture of the selected GPU — quoted here and enforced by the
  // same code when Create runs (never a different number than the server's).
  const assessment = assessGpu({ gpuTypes, value: gpu, plan, concurrentUsed, walletBalanceMicros, storageGb: sizeGb });
  const gpuSelected = gpu.gpuSlug !== null;
  const gpuSku = assessment.sku;
  const selectedImage = images.find((i) => i.slug === imageSlug) ?? null;
  /** A GPU nobody can SSH into must never launch (it would only bill). */
  const gpuNeedsSshKey = gpuSelected && sshMode === "none";
  const gpuBlocked = gpuSelected && assessment.blockReason !== null;

  const stepValid =
    step === 0
      ? name.trim().length > 0
      : step === 1
        ? sizeGb > 0 && storageSizes.length > 0
        : step === 2
          ? !gpuSelected || assessment.blockReason === null
          : step === 3
            ? images.length === 0 || imageSlug !== ""
            : step === 4
              ? true
              : step === 5
                ? sshMode === "generate" || sshMode === "none"
                  ? true
                  : sshMode === "existing"
                    ? existingKeyId !== ""
                    : pasteError === null
                : step === 6
                  ? !gpuSelected || (!gpuNeedsSshKey && assessment.blockReason === null)
                  : true;

  function reset() {
    setStep(0);
    setName("");
    setSizeGb(storageSizes[0]?.size_gb ?? 0);
    setBilling("hourly");
    setGpu(defaultGpuSelection(gpuTypes, plan, concurrentUsed));
    setImageSlug(defaultImageSlug(images));
    setSshMode("generate");
    setExistingKeyId("");
    setPastedKey("");
    setCreatedKey(null);
    setCreatedWorkspaceName("");
    setPendingCheckoutUrl(null);
    setCopied(false);
    setPending(false);
  }

  function closeAndReset() {
    setOpen(false);
    reset();
  }

  /** Close, then send any pending Stripe checkout (booking mode). */
  function finish() {
    const checkoutUrl = pendingCheckoutUrl;
    closeAndReset();
    if (checkoutUrl) window.location.assign(checkoutUrl);
  }

  async function handleCreate() {
    if (pending) return;
    if (gpuNeedsSshKey) {
      toast({
        title: "A GPU needs an SSH key",
        description: "Pick a key above — a machine you can't reach must never start billing.",
        variant: "danger",
      });
      return;
    }
    if (gpuBlocked) {
      toast({ title: "This GPU can't start yet", description: assessment.blockReason ?? undefined, variant: "danger" });
      return;
    }
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

      // Workspace + GPU in ONE request: any failure rolls everything back
      // (no half-created workspace, no money, no orphaned AWS machine).
      const { checkout_url } = await createWorkspaceAction({
        name: name.trim(),
        storage_size_gb: sizeGb,
        billing_mode: isIncluded ? "hourly" : billing,
        ...(sshKeyId ? { ssh_key_id: sshKeyId } : {}),
        ...(imageSlug ? { image_slug: imageSlug } : {}),
        ...(gpuSelected && gpuSku
          ? {
              gpu: {
                gpu_type_slug: gpuSku.slug,
                quantity: assessment.quantity,
                payment_mode: gpu.paymentMode,
                location_preference: gpu.location,
                ...(gpu.paymentMode === "booking" ? { booking_duration: gpu.duration } : {}),
              },
            }
          : {}),
      });

      if (gpuSelected && !checkout_url) {
        toast({
          title: `Workspace "${name.trim()}" created`,
          description: `${assessment.quantity} × ${gpuSku?.display_name} is booting on AWS — billing starts once it's running.`,
          variant: "success",
        });
      } else {
        toast({ title: `Workspace "${name.trim()}" created`, variant: "success" });
      }

      if (generated) {
        setCreatedWorkspaceName(name.trim());
        setCreatedKey(generated);
        setPendingCheckoutUrl(checkout_url ?? null);
        setStep(DOWNLOAD_STEP);
      } else if (checkout_url) {
        window.location.assign(checkout_url);
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

  const gpuSummary = !gpuSelected
    ? "No GPU yet — start one from the workspace card later"
    : gpuSku
      ? `${assessment.quantity} × ${gpuSku.display_name} · ${formatGbp(assessment.hourlyTotalMicros)}/hr`
      : "GPU";

  const imageSummary = selectedImage
    ? `${selectedImage.display_name} · ${selectedImage.is_free ? "free" : `${formatGbp(selectedImage.hourly_price_micros)}/hr`}`
    : "Platform default image";

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
                    A persistent environment that keeps storage, its image and its SSH identity between GPU rentals.
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
                  <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Cpu className="h-3.5 w-3.5" />
                    GPU
                  </p>
                  <GpuPicker
                    gpuTypes={gpuTypes}
                    value={gpu}
                    onChange={setGpu}
                    plan={plan}
                    concurrentUsed={concurrentUsed}
                    walletBalanceMicros={walletBalanceMicros}
                    storageGb={sizeGb}
                    allowNone
                  />
                  <p className="text-xs text-muted-foreground">
                    On Create the platform boots this GPU on AWS and starts billing — you&apos;ll see the total above
                    before anything runs.
                  </p>
                </div>
              )}

              {step === 3 && (
                <div className="space-y-2">
                  <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Image className="h-3.5 w-3.5" />
                    Machine image
                  </p>
                  {images.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No images are listed right now — this workspace will boot the platform default image.
                    </p>
                  )}
                  <div className="space-y-2">
                    {images.map((img) => (
                      <button
                        key={img.slug}
                        onClick={() => setImageSlug(img.slug)}
                        className={`flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors ${
                          imageSlug === img.slug ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"
                        }`}
                      >
                        <span className="mt-0.5 flex-1">
                          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {img.display_name}
                            {img.is_default && <Badge variant="secondary">Default</Badge>}
                            <Badge variant={img.is_free ? "success" : "warning"}>
                              {img.is_free ? "Free" : `${formatGbp(img.hourly_price_micros)}/hr`}
                            </Badge>
                          </span>
                          {img.description && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">{img.description}</span>
                          )}
                        </span>
                        <span
                          className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border ${
                            imageSlug === img.slug ? "border-primary bg-primary" : "border-border"
                          }`}
                        />
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The image rides with this workspace and boots on every GPU start. Free on AWS means free here.
                  </p>
                </div>
              )}

              {step === 4 && (
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

              {step === 5 && (
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
                      description="Only valid without a GPU — a GPU you can't reach must never bill."
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
                    The key is provisioned to every GPU launched from this workspace.
                  </p>
                </div>
              )}

              {step === 6 && (
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
                    <ReviewRow label="GPU" value={gpuSummary} />
                    <ReviewRow label="Image" value={imageSummary} />
                    <ReviewRow
                      label="Billing"
                      value={isIncluded ? "No storage charge (plan included)" : billing === "hourly" ? "Hourly metered" : "Prepaid 30 days"}
                    />
                    <ReviewRow label="SSH key" value={sshSummary} />
                  </dl>

                  {gpuSelected && assessment.price && gpuSku && (
                    <div className="space-y-1 rounded-md bg-muted/30 p-3 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">GPU rate ({gpuSku.display_name})</span>
                        <span className="font-mono-data">{formatGbp(assessment.price.discountedBaseRateMicros)}/hr</span>
                      </div>
                      {assessment.price.premiumMicros > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Region premium</span>
                          <span className="font-mono-data">+{formatGbp(assessment.price.premiumMicros)}/hr</span>
                        </div>
                      )}
                      {assessment.price.storageAddOnMicros > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Instance storage</span>
                          <span className="font-mono-data">+{formatGbp(assessment.price.storageAddOnMicros)}/hr</span>
                        </div>
                      )}
                      <div className="flex justify-between border-t border-border pt-1 font-medium">
                        <span>Total</span>
                        <span className="font-mono-data">{formatGbp(assessment.hourlyTotalMicros)}/hour</span>
                      </div>
                    </div>
                  )}

                  {gpuNeedsSshKey && (
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      A GPU needs an SSH key — go back and pick one, otherwise nobody could reach the machine you&apos;d
                      be billed for.
                    </p>
                  )}
                  {gpuBlocked && (
                    <p className="flex items-start gap-1.5 text-xs text-warning">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {assessment.blockReason}
                    </p>
                  )}
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
              {step < STEP_TITLES.length - 1 ? (
                <Button onClick={() => setStep((s) => s + 1)} disabled={!stepValid || pending}>
                  Next
                  <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button onClick={handleCreate} loading={pending} disabled={!stepValid}>
                  {gpuSelected ? `Create workspace · ${formatGbp(assessment.hourlyTotalMicros)}/hr` : "Create workspace"}
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

              {pendingCheckoutUrl && (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  Next you&apos;ll be taken to checkout to pay for the booking — your GPU starts as soon as the payment
                  completes.
                </div>
              )}

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
              <Button onClick={finish}>{pendingCheckoutUrl ? "Continue to checkout" : "Done"}</Button>
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
