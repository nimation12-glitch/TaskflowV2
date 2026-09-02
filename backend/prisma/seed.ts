/**
 * TaskFlow seed — plans, model catalog, entitlements, pricing rate cards, GPU types.
 * Idempotent: safe to run repeatedly (upserts).
 *
 * Run: bun prisma/seed.ts
 */
import { PrismaClient } from "@prisma/client";

// 1_000_000 micros = £1.00
const POUNDS = (n: number) => Math.round(n * 1_000_000);

const db = new PrismaClient();

const PLANS = [
  {
    id: "free",
    name: "Free",
    description:
      "For exploration and evaluation. £2 of monthly AI usage credits, basic models, 20 requests/minute.",
    monthlyPriceMicros: 0,
    monthlyCreditMicros: POUNDS(2),
    maxMembers: 3, // Free: OWNER + 2 (§20)
    rateLimitPerMinute: 20,
    priority: 0,
    maxConcurrency: 2,
    canRentGpu: false,
    canBuyCredits: false,
    sortOrder: 1,
  },
  {
    id: "pro",
    name: "Pro",
    description:
      "For builders shipping AI features. £15 monthly AI usage credits, broader models, 100 requests/minute, analytics, GPU rental.",
    monthlyPriceMicros: POUNDS(30),
    monthlyCreditMicros: POUNDS(15),
    maxMembers: 10,
    rateLimitPerMinute: 100,
    priority: 5,
    maxConcurrency: 10,
    canRentGpu: true,
    canBuyCredits: true,
    sortOrder: 2,
  },
  {
    id: "max",
    name: "Max",
    description:
      "For demanding workloads. £50 monthly AI usage credits, premium models, 300 requests/minute, highest priority, GPU rental.",
    monthlyPriceMicros: POUNDS(90),
    monthlyCreditMicros: POUNDS(50),
    maxMembers: 25,
    rateLimitPerMinute: 300,
    priority: 10,
    maxConcurrency: 30,
    canRentGpu: true,
    canBuyCredits: true,
    sortOrder: 3,
  },
];

// Model registry (MASTER_PROJECT_CONTEXT §4–7):
//   status       — operator-declared lifecycle: LIVE | COMING_SOON | DISABLED | NOT_CONFIGURED | DEMO_ONLY.
//                  Effective status at read time: declared LIVE + unconfigured provider ⇒ NOT_CONFIGURED.
//   hostingMode  — EXTERNAL_API (third-party serves inference; TaskFlow never claims ownership)
//                  | TASKFLOW_HOSTED (served via TaskFlow-managed platform inference)
//                  | CUSTOMER_HOSTED (customer's own artifact on rented compute).
//   license      — terms summary recorded BEFORE any commercial-hosting claim (§5).
const MODELS = [
  {
    id: "taskflow-mini",
    displayName: "TaskFlow Mini",
    provider: "taskflow",
    description:
      "Fast, low-cost managed model for everyday tasks: drafting, summarising, classification and chat. Served via TaskFlow-managed platform inference.",
    capabilities: ["chat"],
    contextWindow: 16384,
    sortOrder: 1,
    status: "LIVE",
    hostingMode: "TASKFLOW_HOSTED",
    version: "1.0",
    license: "TaskFlow-managed platform inference",
    sourceUrl: null as string | null,
    plans: ["free", "pro", "max"],
    pricing: { input: 800, output: 3200, margin: 25 },
  },
  {
    id: "taskflow-chat",
    displayName: "TaskFlow Chat",
    provider: "taskflow",
    description:
      "Balanced managed model for production chat and assistant workloads with strong instruction following. Served via TaskFlow-managed platform inference.",
    capabilities: ["chat"],
    contextWindow: 32768,
    sortOrder: 2,
    status: "LIVE",
    hostingMode: "TASKFLOW_HOSTED",
    version: "1.0",
    license: "TaskFlow-managed platform inference",
    sourceUrl: null as string | null,
    plans: ["free", "pro", "max"],
    pricing: { input: 1500, output: 6000, margin: 25 },
  },
  {
    id: "taskflow-reasoning",
    displayName: "TaskFlow Reasoning",
    provider: "taskflow",
    description:
      "Managed reasoning model for multi-step problems, code generation and analysis. Pro and Max tiers. Served via TaskFlow-managed platform inference.",
    capabilities: ["chat", "reasoning"],
    contextWindow: 32768,
    sortOrder: 3,
    status: "LIVE",
    hostingMode: "TASKFLOW_HOSTED",
    version: "1.0",
    license: "TaskFlow-managed platform inference",
    sourceUrl: null as string | null,
    plans: ["pro", "max"],
    pricing: { input: 4000, output: 16000, margin: 30 },
  },
  {
    id: "taskflow-vision",
    displayName: "TaskFlow Vision",
    provider: "taskflow",
    description:
      "Multimodal managed model that understands images alongside text. Pro and Max tiers. Served via TaskFlow-managed platform inference.",
    capabilities: ["chat", "vision"],
    contextWindow: 16384,
    sortOrder: 4,
    status: "LIVE",
    hostingMode: "TASKFLOW_HOSTED",
    version: "1.0",
    license: "TaskFlow-managed platform inference",
    sourceUrl: null as string | null,
    plans: ["pro", "max"],
    pricing: { input: 2500, output: 10000, margin: 25 },
  },
  {
    id: "kimi-k3",
    displayName: "Kimi K3",
    provider: "moonshot",
    description:
      "Long-context external model routed via Moonshot. TaskFlow does not host this model; inference is supplied by the upstream provider once its credentials are configured on this deployment.",
    capabilities: ["chat", "reasoning", "long-context"],
    contextWindow: 131072,
    sortOrder: 5,
    status: "LIVE",
    hostingMode: "EXTERNAL_API",
    version: "K3",
    license: "Moonshot AI API Terms of Service",
    sourceUrl: "https://platform.moonshot.ai",
    plans: ["pro", "max"],
    pricing: { input: 3000, output: 12000, margin: 20 },
  },
  {
    id: "llama-3.3-70b",
    displayName: "Llama 3.3 70B",
    provider: "openrouter",
    description:
      "Open-weights flagship routed via OpenRouter. TaskFlow does not host this model; inference is supplied by the upstream provider once its credentials are configured on this deployment.",
    capabilities: ["chat"],
    contextWindow: 131072,
    sortOrder: 6,
    status: "LIVE",
    hostingMode: "EXTERNAL_API",
    version: "3.3-70B-Instruct",
    license: "Llama 3.3 Community License (commercial use via API providers permitted)",
    sourceUrl: "https://www.llama.com",
    plans: ["pro", "max"],
    pricing: { input: 900, output: 3600, margin: 20 },
  },
];

// EXAMPLE ONLY — hourly rental rates are configurable in the database, not final.
const GPU_TYPES = [
  {
    id: "l4",
    displayName: "NVIDIA L4",
    vramGb: 24,
    hourlyRateMicros: 350_000, // £0.35/hr
    description: "Cost-efficient inference GPU. Great for small-to-medium managed deployments.",
    sortOrder: 1,
  },
  {
    id: "rtx-4090",
    displayName: "NVIDIA RTX 4090",
    vramGb: 24,
    hourlyRateMicros: 450_000, // £0.45/hr
    description: "High single-card throughput for small model hosting and experimentation.",
    sortOrder: 2,
  },
  {
    id: "l40s",
    displayName: "NVIDIA L40S",
    vramGb: 48,
    hourlyRateMicros: 850_000, // £0.85/hr
    description: "48GB for larger batches and heavier inference workloads.",
    sortOrder: 3,
  },
  {
    id: "a100-80gb",
    displayName: "NVIDIA A100 80GB",
    vramGb: 80,
    hourlyRateMicros: 1_900_000, // £1.90/hr
    description: "Datacentre workhorse for large-model inference and fine-tuning.",
    sortOrder: 4,
  },
  {
    id: "h100",
    displayName: "NVIDIA H100",
    vramGb: 80,
    hourlyRateMicros: 2_900_000, // £2.90/hr
    description: "Premium compute for frontier-scale models. Max tier deployments.",
    sortOrder: 5,
  },
];

async function main() {
  console.log("Seeding TaskFlow…");

  for (const plan of PLANS) {
    await db.plan.upsert({ where: { id: plan.id }, create: plan, update: plan });
  }
  console.log(`✓ ${PLANS.length} plans`);

  for (const m of MODELS) {
    const registryFields = {
      displayName: m.displayName,
      provider: m.provider,
      description: m.description,
      capabilities: JSON.stringify(m.capabilities),
      contextWindow: m.contextWindow,
      sortOrder: m.sortOrder,
      status: m.status,
      hostingMode: m.hostingMode,
      version: m.version,
      license: m.license,
      sourceUrl: m.sourceUrl,
    };
    const model = await db.aiModel.upsert({
      where: { id: m.id },
      create: { id: m.id, ...registryFields },
      update: registryFields,
    });

    await db.modelPricing.upsert({
      where: { modelId: model.id },
      create: {
        modelId: model.id,
        inputCostPer1kMicros: m.pricing.input,
        outputCostPer1kMicros: m.pricing.output,
        marginPercent: m.pricing.margin,
      },
      update: {
        inputCostPer1kMicros: m.pricing.input,
        outputCostPer1kMicros: m.pricing.output,
        marginPercent: m.pricing.margin,
      },
    });

    // Reset entitlements to the declared set (idempotent)
    await db.modelEntitlement.deleteMany({ where: { modelId: model.id } });
    await db.modelEntitlement.createMany({
      data: m.plans.map((planId) => ({ modelId: model.id, planId })),
    });
  }
  console.log(`✓ ${MODELS.length} models with entitlements + pricing`);

  for (const g of GPU_TYPES) {
    await db.gpuType.upsert({ where: { id: g.id }, create: g, update: g });
  }
  console.log(`✓ ${GPU_TYPES.length} GPU catalog types`);

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
