"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createRental, stopRental, startRental, terminateRental, topUpWallet } from "@/lib/compute-client";

export async function createRentalAction(input: {
  gpu_type_slug: string;
  storage_gb: number;
  ssh_key_id: string;
  payment_mode: "pay_as_you_go" | "booking";
  booking_duration?: "day" | "week";
}) {
  const result = await createRental(input);
  if ("checkout_url" in result) {
    redirect(result.checkout_url);
  }
  revalidatePath("/dashboard/compute");
  return result;
}

export async function stopRentalAction(id: string) {
  await stopRental(id);
  revalidatePath("/dashboard/compute");
}

export async function startRentalAction(id: string) {
  await startRental(id);
  revalidatePath("/dashboard/compute");
}

export async function terminateRentalAction(id: string) {
  await terminateRental(id);
  revalidatePath("/dashboard/compute");
}

export async function topUpWalletAction(amountMicros: number) {
  const { checkout_url } = await topUpWallet(amountMicros);
  redirect(checkout_url);
}
