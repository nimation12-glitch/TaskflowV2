"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  status: string;
  created_at: string;
  last_used_at: string | null;
};

export function ApiKeysClient({ initialKeys }: { initialKeys: ApiKeyRow[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [newName, setNewName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    startTransition(async () => {
      const result = await createApiKeyAction(newName.trim());
      setRevealedKey(result.raw_key);
      setKeys((prev) => [
        { id: result.id, name: result.name, prefix: result.prefix, status: "ACTIVE", created_at: result.created_at, last_used_at: null },
        ...prev,
      ]);
      setNewName("");
    });
  }

  function handleRevoke(id: string) {
    startTransition(async () => {
      await revokeApiKeyAction(id);
      setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, status: "REVOKED" } : k)));
    });
  }

  return (
    <div className="mt-6 space-y-6">
      <form onSubmit={handleCreate} className="flex gap-2">
        <Input placeholder="Key name (e.g. production)" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Button type="submit" disabled={pending}>
          Create key
        </Button>
      </form>

      {revealedKey && (
        <Card className="border-primary">
          <CardContent className="pt-5">
            <p className="text-sm font-medium">Copy this key now — it won't be shown again.</p>
            <code className="mt-2 block break-all rounded-md bg-muted/50 px-3 py-2 font-mono-data text-sm">
              {revealedKey}
            </code>
            <Button variant="secondary" className="mt-3" onClick={() => setRevealedKey(null)}>
              Done, I've saved it
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="divide-y divide-border rounded-lg border border-border">
        {keys.length === 0 && <p className="p-5 text-sm text-muted-foreground">No API keys yet.</p>}
        {keys.map((k) => (
          <div key={k.id} className="flex items-center justify-between p-4">
            <div>
              <p className="text-sm font-medium">{k.name}</p>
              <p className="font-mono-data text-xs text-muted-foreground">{k.prefix}••••••••</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-xs ${k.status === "ACTIVE" ? "text-emerald-400" : "text-muted-foreground"}`}>
                {k.status}
              </span>
              {k.status === "ACTIVE" && (
                <Button variant="danger" onClick={() => handleRevoke(k.id)} disabled={pending}>
                  Revoke
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
