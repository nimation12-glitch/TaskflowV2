"use client";

import { useMemo, useState } from "react";
import { Copy, Check, KeyRound, Search, Plus, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, StatusDot } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogTrigger } from "@/components/ui/dialog";
import { useAction } from "@/lib/hooks/use-action";
import { formatDateTime } from "@/lib/utils";
import { createApiKeyAction, revokeApiKeyAction, pauseApiKeyAction, resumeApiKeyAction } from "./actions";
import type { ApiKey } from "@/lib/api-keys-client";

const STATUS_META: Record<ApiKey["status"], { label: string; variant: "success" | "warning" | "outline" }> = {
  ACTIVE: { label: "Active", variant: "success" },
  PAUSED: { label: "Paused", variant: "warning" },
  REVOKED: { label: "Revoked", variant: "outline" },
};

function CopyPrefixButton({ prefix }: { prefix: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(prefix);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono-data text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {prefix}••••••••
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy prefix"}</TooltipContent>
    </Tooltip>
  );
}

export function ApiKeysClient({ initialKeys }: { initialKeys: ApiKey[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [revealedKey, setRevealedKey] = useState<{ raw: string; name: string } | null>(null);
  const { pending, run } = useAction();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return keys;
    return keys.filter((k) => k.name.toLowerCase().includes(q) || k.prefix.toLowerCase().includes(q));
  }, [keys, query]);

  const active = filtered.filter((k) => k.status === "ACTIVE" || k.status === "PAUSED");
  const revoked = filtered.filter((k) => k.status === "REVOKED");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    run(() => createApiKeyAction(name), {
      onSuccess: (result) => {
        setRevealedKey({ raw: result.raw_key, name: result.name });
        setKeys((prev) => [
          { id: result.id, name: result.name, prefix: result.prefix, status: "ACTIVE", created_at: result.created_at, last_used_at: null },
          ...prev,
        ]);
        setNewName("");
      },
      error: "Couldn't create the key",
    });
  }

  function handlePauseToggle(key: ApiKey) {
    const action = key.status === "PAUSED" ? resumeApiKeyAction : pauseApiKeyAction;
    const nextStatus = key.status === "PAUSED" ? "ACTIVE" : "PAUSED";
    run(() => action(key.id), {
      success: key.status === "PAUSED" ? `"${key.name}" resumed` : `"${key.name}" paused`,
      error: "Couldn't update that key",
      onSuccess: () => setKeys((prev) => prev.map((k) => (k.id === key.id ? { ...k, status: nextStatus } : k))),
    });
  }

  function handleRevoke(id: string, name: string) {
    run(() => revokeApiKeyAction(id), {
      success: `"${name}" revoked`,
      error: "Couldn't revoke the key",
      onSuccess: () => setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, status: "REVOKED" } : k))),
    });
  }

  return (
    <div className="mt-6 space-y-6">
      <form onSubmit={handleCreate} className="flex gap-2">
        <Input placeholder="Key name (e.g. production)" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Button type="submit" loading={pending} disabled={!newName.trim()}>
          <Plus className="h-4 w-4" />
          Create key
        </Button>
      </form>

      {revealedKey && (
        <Card className="border-primary/60">
          <CardContent className="pt-5">
            <p className="text-sm font-medium">Copy "{revealedKey.name}" now — it won't be shown again.</p>
            <code className="mt-2 block break-all rounded-md bg-muted/50 px-3 py-2 font-mono-data text-sm">{revealedKey.raw}</code>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(revealedKey.raw);
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy key
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRevealedKey(null)}>
                Done, I've saved it
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {keys.length > 0 && (
        <div className="relative max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search keys…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
        </div>
      )}

      {keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys yet"
          description="Create a key above once the AI Model Gateway is back — keys created now will work as soon as it's live."
        />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title="No keys match your search" description="Try a different name or prefix." />
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Active <span className="font-normal normal-case">({active.length})</span>
              </h2>
              <div className="divide-y divide-border rounded-lg border border-border">
                {active.map((k) => {
                  const meta = STATUS_META[k.status];
                  return (
                    <div key={k.id} className="flex items-center justify-between p-4">
                      <div>
                        <p className="text-sm font-medium">{k.name}</p>
                        <div className="mt-0.5 flex items-center gap-2">
                          <CopyPrefixButton prefix={k.prefix} />
                          {k.last_used_at && (
                            <span className="text-xs text-muted-foreground">· last used {formatDateTime(k.last_used_at)}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant={meta.variant}>
                          <StatusDot variant={meta.variant} /> {meta.label}
                        </Badge>
                        <Button variant="secondary" size="sm" onClick={() => handlePauseToggle(k)} disabled={pending}>
                          {k.status === "PAUSED" ? (
                            <>
                              <Play className="h-3.5 w-3.5" /> Resume
                            </>
                          ) : (
                            <>
                              <Pause className="h-3.5 w-3.5" /> Pause
                            </>
                          )}
                        </Button>
                        <ConfirmDialog
                          trigger={
                            <DialogTrigger asChild>
                              <Button variant="danger" size="sm">
                                Revoke
                              </Button>
                            </DialogTrigger>
                          }
                          title="Revoke this API key?"
                          description="Any application using this key will immediately stop being able to authenticate. This can't be undone — you'd need to create a new key."
                          confirmLabel="Revoke key"
                          variant="danger"
                          pending={pending}
                          onConfirm={() => handleRevoke(k.id, k.name)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {revoked.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Revoked <span className="font-normal normal-case">({revoked.length})</span>
              </h2>
              <div className="divide-y divide-border rounded-lg border border-border opacity-70">
                {revoked.map((k) => (
                  <div key={k.id} className="flex items-center justify-between p-4">
                    <div>
                      <p className="text-sm font-medium">{k.name}</p>
                      <p className="font-mono-data text-xs text-muted-foreground">{k.prefix}••••••••</p>
                    </div>
                    <Badge variant="outline">
                      <StatusDot /> Revoked
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
