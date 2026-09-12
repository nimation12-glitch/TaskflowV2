"use server";

import { revalidatePath } from "next/cache";
import { setMaintenanceMode } from "@/lib/system-client";

export async function setMaintenanceModeAction(enabled: boolean, message: string | null) {
  const result = await setMaintenanceMode({ enabled, message });
  // Every page reads maintenance status via the root layout, so revalidate
  // broadly rather than just this one route.
  revalidatePath("/", "layout");
  return result;
}
