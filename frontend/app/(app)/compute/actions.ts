"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { stopRental, startRental, terminateRental, topUpWallet } from "@/lib/compute-client";

// NOTE: GPU rentals are no longer started from a standalone panel — the GPU
// is chosen in workspace setup (POST /workspaces with `gpu`), so the only
// rental actions left here are the lifecycle controls the rental cards use.

export async function stopRentalAction(id: string) {
  await stopRental(id);
  revalidatePath("/compute");
}

export async function startRentalAction(id: string) {
  await startRental(id);
  revalidatePath("/compute");
}

export async function terminateRentalAction(id: string) {
  await terminateRental(id);
  revalidatePath("/compute");
}

export async function topUpWalletAction(amountMicros: number) {
  const { checkout_url } = await topUpWallet(amountMicros);
  redirect(checkout_url);
}
