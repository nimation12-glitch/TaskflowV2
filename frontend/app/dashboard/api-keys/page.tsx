import { backendJson } from "@/lib/backend-client";
import { ApiKeysClient } from "./api-keys-client";

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  status: string;
  created_at: string;
  last_used_at: string | null;
};

export default async function ApiKeysPage() {
  const keys = await backendJson<ApiKeyRow[]>("/api-keys");
  return (
    <div>
      <h1 className="text-2xl font-semibold">API keys</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Keys authenticate requests to the TaskFlow API. The full key is shown once, right after creation.
      </p>
      <ApiKeysClient initialKeys={keys} />
    </div>
  );
}
