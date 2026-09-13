import "server-only";
import { backendJson } from "@/lib/backend-client";
import type { GpuTier, WalletSummary, Rental } from "@/lib/compute-types";

// NOTE: this file assumes the /compute/* backend contract from the spec.
// Every call is isolated here so response-shape changes only need edits in this file.

export async function getGpuTypes() {
  const res = await backendJson<{ gpu_types: GpuTier[] }>("/compute/gpu-types");
  return res.gpu_types;
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

export async function getRentals() {
  const res = await backendJson<{ rentals: Rental[] }>("/compute/rentals");
  return res.rentals;
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

export type UsagePeriod = "day" | "month" | "year";

export type UsageSummary = {
  period: UsagePeriod;
  total_spend_micros: number;
  total_gpu_hours: number;
  spend_by_bucket: { bucket_start: string; spend_micros: number }[];
  most_used_gpu_type: { slug: string; display_name: string; hours: number; spend_micros: number } | null;
  by_gpu_type: { slug: string; display_name: string; hours: number; spend_micros: number }[];
};

/**
 * Ranked by hours rented, not spend — most_used_gpu_type reflects that
 * directly from the backend, so don't relabel it "highest spend" in the UI.
 * by_gpu_type can legitimately be empty even with non-zero total_spend_micros
 * (usage billed before this endpoint existed isn't tier-linked on the
 * backend) — that's a "not enough data yet" state, not an error.
 */
export function getUsageSummary(period: UsagePeriod) {
  return backendJson<UsageSummary>(`/compute/usage-summary?period=${period}`);
}
