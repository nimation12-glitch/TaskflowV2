export type PlanCode = "FREE" | "PRO" | "MAX";

export type GpuTier = {
  slug: "starter" | "standard" | "performance" | "max";
  display_name: string;
  gpu: string;
  vram_gb: number;
  vcpu: number;
  ram_gb: number;
  base_price_micros_per_hour: number;
};

export type WalletSummary = {
  balance_micros: number;
  estimated_hours_remaining_at_current_rate: number | null;
};

export type RentalStatus = "PROVISIONING" | "RUNNING" | "STOPPED" | "TERMINATING" | "TERMINATED" | "FAILED";

export type Rental = {
  id: string;
  gpu_type_slug: GpuTier["slug"];
  storage_gb: number;
  status: RentalStatus;
  payment_mode: "pay_as_you_go" | "booking";
  ssh_key_id: string;
  ssh_key_label?: string;
  public_ip: string | null;
  started_at: string | null;
  created_at: string;
  accrued_cost_micros: number | null;
  booking_expires_at: string | null;
  error_detail: string | null;
};

export type SshKey = {
  id: string;
  label: string;
  fingerprint: string;
  created_at: string;
};

/** Storage options and which plans unlock them. */
export const STORAGE_OPTIONS = [
  { gb: 50, minPlan: "FREE" as PlanCode },
  { gb: 100, minPlan: "FREE" as PlanCode },
  { gb: 250, minPlan: "PRO" as PlanCode },
  { gb: 500, minPlan: "MAX" as PlanCode },
];

export const PLAN_LIMITS: Record<
  PlanCode,
  {
    concurrentRentals: number;
    maxStorageGb: number;
    maxSessionHours: number | null; // null = governed by booking length instead
    bookingAllowed: boolean;
    maxBookingDays: number; // 0 = not allowed
    ratesMultiplier: number;
    queuePriority: "Lowest" | "Normal" | "Highest";
  }
> = {
  FREE: { concurrentRentals: 1, maxStorageGb: 50, maxSessionHours: 4, bookingAllowed: false, maxBookingDays: 0, ratesMultiplier: 1, queuePriority: "Lowest" },
  PRO: { concurrentRentals: 3, maxStorageGb: 250, maxSessionHours: 24 * 7, bookingAllowed: true, maxBookingDays: 7, ratesMultiplier: 0.9, queuePriority: "Normal" },
  MAX: { concurrentRentals: 10, maxStorageGb: 500, maxSessionHours: 24 * 14, bookingAllowed: true, maxBookingDays: 14, ratesMultiplier: 0.8, queuePriority: "Highest" },
};
