"use server";

import { revalidatePath } from "next/cache";
import { adjustOrganizationCredits, changeOrganizationPlan, type PlanCode } from "@/lib/admin-client";

export async function adjustCreditsAction(orgId: string, amountMicros: number, reason: string) {
  const result = await adjustOrganizationCredits(orgId, { amount_micros: amountMicros, reason });
  revalidatePath(`/admin/organizations/${orgId}`);
  revalidatePath("/admin/organizations");
  return result;
}

export async function changePlanAction(orgId: string, planCode: PlanCode) {
  const result = await changeOrganizationPlan(orgId, planCode);
  revalidatePath(`/admin/organizations/${orgId}`);
  revalidatePath("/admin/organizations");
  return result;
}
