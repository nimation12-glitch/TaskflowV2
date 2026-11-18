export type PlanCode = "FREE" | "PRO" | "ULTRA" | "MAX";

/** One offered (SKU x region) row of the launch matrix (spec §12/§13). */
export type SkuRegion = {
  code: string;
  /** Public region name (e.g. "UK London") as served by the backend. */
  name?: string;
  area: string;
  /** Regional service premium in micro-GBP/hr — never plan-discounted (§24). */
  premium_micros: number;
  /** §14 estimate: provisioning start -> instance running, in seconds. */
  startup_estimate_seconds: number;
  /** Cached regional AMI (§15); null until the first SSM resolution. */
  ami_id?: string | null;
};

/** The machine image every launch in every region boots (§15). */
export type MachineImage = {
  name: string;
  /** Public SSM parameter the AMI id is resolved from at launch. */
  ssm_parameter: string;
};

export type GpuSku = {
  slug: string;
  display_name: string;
  /** e.g. "NVIDIA T4" — the family label SKUs are grouped by. */
  gpu: string;
  gpu_count: number;
  tier: "STARTER" | "STANDARD" | "PRO" | "ULTRA";
  vram_gb: number;
  vcpu: number;
  ram_gb: number;
  /**
   * False = not rentable yet (regional AMI still unresolved). The catalogue
   * lists it for visibility; the backend refuses creation regardless.
   */
  enabled: boolean;
  /** Fixed base price (§10/§11): plans buy access, never rate discounts. */
  price_micros_per_hour: number;
  /** Base after the caller's plan adjustment (identity at current plan rates). */
  effective_price_micros_per_hour: number;
  /** §20 minimum wallet cover before launch, in hours. */
  minimum_rental_hours: number;
  /** Whether the caller's plan may use booking mode. */
  booking_allowed: boolean;
  /** Machine image booted on launch (resolved to a regional AMI id per region). */
  image?: MachineImage;
  regions: {
    offered: SkuRegion[];
    /** Regions the spec marks N/A for this configuration (§12). */
    not_offered: string[];
  };
};

export type WalletSummary = {
  balance_micros: number;
  estimated_hours_remaining_at_current_rate: number | null;
};

export type RentalStatus =
  | "PENDING_PAYMENT"
  | "PROVISIONING"
  | "RUNNING"
  | "STOPPING"
  | "STOPPED"
  | "TERMINATING"
  | "TERMINATED"
  | "FAILED";

export type Rental = {
  id: string;
  gpu_type_slug: string;
  storage_gb: number;
  status: RentalStatus;
  payment_mode: "pay_as_you_go" | "booking";
  booking_duration: "day" | "week" | null;
  ssh_key_id: string;
  ssh_key_label?: string;
  workspace_id: string | null;
  public_ip: string | null;
  started_at: string | null;
  created_at: string;
  accrued_cost_micros: number | null;
  hourly_rate_micros: number | null;
  /** Launch geography (§13): null only for pre-regions legacy rows. */
  region_code: string | null;
  availability_zone: string | null;
  /** Regional premium included in hourly_rate_micros (§24). */
  regional_premium_micros: number;
  booking_expires_at: string | null;
  error_detail: string | null;
};

export type SshKey = {
  id: string;
  label: string;
  fingerprint: string;
  created_at: string;
};

/** Location preferences accepted by the scheduler (spec §13). */
export type LocationPreference = "automatic" | "uk" | "europe" | "north_america" | "asia";

export const LOCATION_OPTIONS: { value: LocationPreference; label: string }[] = [
  { value: "automatic", label: "Automatic — best available" },
  { value: "uk", label: "UK" },
  { value: "europe", label: "Europe" },
  { value: "north_america", label: "North America" },
  { value: "asia", label: "Asia" },
];

/** Area bucket each region belongs to (mirrors backend regions.country_or_area). */
export const REGION_AREAS: Record<string, string> = {
  "us-east-1": "North America",
  "us-west-2": "North America",
  "eu-north-1": "Europe",
  "eu-west-2": "UK",
  "eu-central-1": "Europe",
  "ap-northeast-1": "Asia",
};

/** Display names for the 6 launch regions (spec §12). */
export const REGION_NAMES: Record<string, string> = {
  "us-east-1": "US East (N. Virginia)",
  "us-west-2": "US West (Oregon)",
  "eu-north-1": "EU North (Stockholm)",
  "eu-west-2": "UK London",
  "eu-central-1": "EU Central (Frankfurt)",
  "ap-northeast-1": "Asia Pacific Tokyo",
};

/** Storage options per rental, and the plan floor for each. */
export const STORAGE_OPTIONS = [
  { gb: 50, minPlan: "FREE" as PlanCode },
  { gb: 100, minPlan: "FREE" as PlanCode },
  { gb: 250, minPlan: "PRO" as PlanCode },
  { gb: 500, minPlan: "ULTRA" as PlanCode },
];

// Spec (§2/§11): prices are fixed — plans buy access, never rate discounts,
// so ratesMultiplier is 1 on every plan. Kept as an explicit field so the
// display path stays honest and any future change is a deliberate one.
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
  PRO: { concurrentRentals: 3, maxStorageGb: 250, maxSessionHours: 24 * 7, bookingAllowed: true, maxBookingDays: 7, ratesMultiplier: 1, queuePriority: "Normal" },
  ULTRA: { concurrentRentals: 6, maxStorageGb: 500, maxSessionHours: 24 * 14, bookingAllowed: true, maxBookingDays: 14, ratesMultiplier: 1, queuePriority: "Highest" },
  MAX: { concurrentRentals: 10, maxStorageGb: 1024, maxSessionHours: 24 * 14, bookingAllowed: true, maxBookingDays: 14, ratesMultiplier: 1, queuePriority: "Highest" },
};
