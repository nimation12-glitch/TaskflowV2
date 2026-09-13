import { getApiKeys } from "@/lib/api-keys-client";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { safe } from "@/lib/safe-fetch";
import { ApiKeysClient } from "./api-keys-client";

export default async function ApiKeysPage() {
  const { data: keys, ok } = await safe(getApiKeys(), []);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
      <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
        Keys for the AI Model Gateway. The gateway itself is paused while we focus on GPU rental, but you can still
        manage keys here — pause one to stop it working temporarily without revoking it outright.
      </p>
      {!ok && (
        <div className="mt-4">
          <UnavailableNotice label="API key data" />
        </div>
      )}
      <ApiKeysClient initialKeys={keys} />
    </div>
  );
}
