"use server";

import { revalidatePath } from "next/cache";
import { createApiKey, revokeApiKey, pauseApiKey, resumeApiKey } from "@/lib/api-keys-client";

export async function createApiKeyAction(name: string) {
  const key = await createApiKey(name);
  revalidatePath("/api-keys");
  return key;
}

export async function revokeApiKeyAction(id: string) {
  await revokeApiKey(id);
  revalidatePath("/api-keys");
}

export async function pauseApiKeyAction(id: string) {
  await pauseApiKey(id);
  revalidatePath("/api-keys");
}

export async function resumeApiKeyAction(id: string) {
  await resumeApiKey(id);
  revalidatePath("/api-keys");
}
