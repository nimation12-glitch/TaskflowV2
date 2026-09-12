import "server-only";
import { backendJson } from "@/lib/backend-client";
import type { GpuTier, WalletSummary, Rental } from "@/lib/compute-types";

// NOTE: this file assumes the /compute/* backend contract from the spec.
// Every call is isolated here so response-shape changes only need edits in this file.

export function getGpuTypes() {
  return backendJson<GpuTier[]>("/compute/gpu-types");
}

export function getWallet() {
  return backendJson<WalletSummary>("/compute/wallet");
}

export function topUpWallet(amountMicros: number) {
  return backendJson<{ checkout_url: string }>("/compute/wallet/topup", {
    method: "POST",
    body: JSON.stringify({ amount_micros: amountMicros }),
  });
}

export function getRentals() {
  return backendJson<Rental[]>("/compute/rentals");
}

export function createRental(input: {
  gpu_type_slug: string;
  storage_gb: number;
  ssh_key_id: string;
  payment_mode: "pay_as_you_go" | "booking";
  booking_duration?: "day" | "week";
}) {
  return backendJson<Rental | { checkout_url: string }>("/compute/rentals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function stopRental(id: string) {
  return backendJson<Rental>(`/compute/rentals/${id}/stop`, { method: "POST" });
}

export function startRental(id: string) {
  return backendJson<Rental>(`/compute/rentals/${id}/start`, { method: "POST" });
}

export function terminateRental(id: string) {
  return backendJson<void>(`/compute/rentals/${id}`, { method: "DELETE" });
}
