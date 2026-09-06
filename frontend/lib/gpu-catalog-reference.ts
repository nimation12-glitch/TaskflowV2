// The landing page is public and unauthenticated, so it can't call the backend through
// backendJson (which requires a session). This mirrors the real catalog for marketing
// copy only — the authenticated Compute page always renders live data from
// lib/compute-client.ts's getGpuTypes(). Keep these numbers in sync with the backend.
export const GPU_CATALOG_REFERENCE = [
  { slug: "starter", display_name: "Starter", gpu: "NVIDIA T4", vram_gb: 16, vcpu: 4, ram_gb: 16, base_price_gbp_per_hour: 0.75 },
  { slug: "standard", display_name: "Standard", gpu: "NVIDIA A10G", vram_gb: 24, vcpu: 4, ram_gb: 16, base_price_gbp_per_hour: 1.4 },
  { slug: "performance", display_name: "Performance", gpu: "NVIDIA A10G", vram_gb: 24, vcpu: 8, ram_gb: 32, base_price_gbp_per_hour: 1.7 },
  { slug: "max", display_name: "Max", gpu: "NVIDIA A10G", vram_gb: 24, vcpu: 16, ram_gb: 64, base_price_gbp_per_hour: 2.25 },
] as const;
