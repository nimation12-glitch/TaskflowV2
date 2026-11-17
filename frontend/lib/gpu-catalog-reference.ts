// The landing page is public and unauthenticated, so it can't call the backend
// through backendJson (which requires a session). This mirrors the real
// catalogue at family level for marketing copy only — the authenticated
// Compute page always renders live data from lib/compute-client.ts's
// getGpuTypes(). Keep these numbers in sync with backend/scripts/seed.py
// (they are each family's cheapest configuration's fixed list price, §10/§11).
export const GPU_CATALOG_REFERENCE = [
  { family: "NVIDIA T4", vram_gb: 16, vcpu: 4, ram_gb: 16, from_price_gbp_per_hour: 1.18, note: "From £1.18/hr" },
  { family: "NVIDIA L4", vram_gb: 24, vcpu: 4, ram_gb: 16, from_price_gbp_per_hour: 1.78, note: "From £1.78/hr" },
  { family: "NVIDIA A10G", vram_gb: 24, vcpu: 4, ram_gb: 16, from_price_gbp_per_hour: 2.23, note: "From £2.23/hr" },
  { family: "NVIDIA L40S", vram_gb: 48, vcpu: 4, ram_gb: 32, from_price_gbp_per_hour: 4.13, note: "From £4.13/hr" },
  { family: "NVIDIA H100", vram_gb: 80, vcpu: 16, ram_gb: 256, from_price_gbp_per_hour: 15.23, note: "From £15.23/hr" },
  { family: "NVIDIA A100", vram_gb: 320, vcpu: 96, ram_gb: 1152, from_price_gbp_per_hour: 48.72, note: "8-GPU node · £48.72/hr" },
] as const;
