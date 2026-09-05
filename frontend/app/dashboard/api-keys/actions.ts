"use server";

import { revalidatePath } from "next/cache";
import { backendJson } from "@/lib/backend-client";

export async function createApiKeyAction(name: string) {
  const result = await backendJson<{ id: string; name: string; prefix: string; raw_key: string; created_at: string }>(
    "/api-keys",
    { method: "POST", body: JSON.stringify({ name }) }
  );
  revalidatePath("/dashboard/api-keys");
  return result;
}

export async function revokeApiKeyAction(id: string) {
  await backendJson(`/api-keys/${id}`, { method: "DELETE" });
  revalidatePath("/dashboard/api-keys");
}
