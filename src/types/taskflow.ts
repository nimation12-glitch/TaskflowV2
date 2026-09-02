/** Shared frontend types for the TaskFlow dashboard. */

/** Real Stripe billing modes (spec §13) — there is no simulated mode. */
export type BillingMode = "live" | "test" | "unconfigured";

export type OrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
  isPersonal: boolean;
};

export type ConnectedProvider = {
  id: string;
  provider: string;
  providerEmail: string | null;
  createdAt: string;
};

export type MeResponse = {
  user: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    status: "PENDING" | "ACTIVE" | "SUSPENDED";
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
    createdAt: string;
    lastLoginAt: string | null;
  } | null;
  /** True when the verification policy is not yet satisfied (§17). */
  pending?: boolean;
  organization: { id: string; name: string; slug: string; isPersonal: boolean } | null;
  role: "OWNER" | "ADMIN" | "MEMBER" | null;
  organizations: OrgSummary[];
  providers: ConnectedProvider[];
  sms?: { transport: string; configured: boolean };
  subscription: {
    planId: string;
    planName: string;
    status: string;
    entitled: boolean;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    monthlyPriceMicros: number;
    monthlyCreditMicros: number;
    rateLimitPerMinute: number;
    priority: number;
    maxConcurrency: number;
    canRentGpu: boolean;
    canBuyCredits: boolean;
  } | null;
  credits: { balanceMicros: number; balanceGBP: number; autoTopUpEnabled: boolean };
  usageThisMonth: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    chargedMicros: number;
  };
  billingMode: BillingMode;
};

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  status: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  permissions?: string | null;
};

export type CreateKeyResponse = {
  key: { id: string; name: string; prefix: string; status: string; createdAt: string };
  rawKey: string;
  warning: string;
};

export type UsageResponse = {
  period: { days: number };
  totals: {
    requests: number;
    successfulRequests: number;
    failedRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    aiUsageMicros: number;
    aiUsageGBP: number;
    computeSeconds: number;
  };
  credits: { balanceMicros: number; remainingGBP: number };
  daily: Array<{ date: string; requests: number; chargedMicros: number; tokens: number }>;
  models: Array<{
    modelId: string;
    displayName: string;
    provider: string;
    requests: number;
    chargedMicros: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  providers: Array<{ provider: string; requests: number; chargedMicros: number }>;
  recentEvents: Array<{
    id: string;
    requestId: string;
    model: string;
    modelId: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    status: string;
    latencyMs: number;
    chargeMicros: number;
    createdAt: string;
  }>;
};

export type CreditsResponse = {
  balanceMicros: number;
  balanceGBP: number;
  autoTopUp: { enabled: boolean; thresholdMicros: number | null; amountMicros: number | null };
  transactions: Array<{
    id: string;
    type: string;
    amountMicros: number;
    amountGBP: number;
    balanceAfterMicros: number;
    balanceAfterGBP: number;
    description: string;
    referenceId: string | null;
    uniqueGrantKey?: string | null;
    stripe?: { paymentIntentId: string | null; checkoutSessionId: string | null; eventId: string | null; invoiceId: string | null } | null;
    createdAt: string;
  }>;
};

export type ModelRow = {
  id: string;
  displayName: string;
  provider: string;
  description: string;
  capabilities: string[];
  contextWindow: number;
  status: "LIVE" | "COMING_SOON" | "DISABLED" | "NOT_CONFIGURED" | "DEMO_ONLY";
  hostingMode: "EXTERNAL_API" | "TASKFLOW_HOSTED" | "CUSTOMER_HOSTED";
  version: string | null;
  license: string | null;
  sourceUrl: string | null;
  availableToYou: boolean;
  tierRequirement: "FREE" | "PRO" | "MAX";
  plans: string[];
  pricing: {
    inputPer1kMicros: number;
    outputPer1kMicros: number;
    inputPer1kGBP: number;
    outputPer1kGBP: number;
    marginPercent: number;
    currency: string;
  } | null;
};

export type ModelsResponse = { models: ModelRow[]; currentPlan: string };

export type InvoiceRow = {
  id: string;
  number: string;
  description: string;
  amountMicros: number;
  amountGBP: number;
  currency: string;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  hostedUrl: string | null;
  createdAt: string;
};

export type PlanInfo = {
  id: string;
  name: string;
  description: string;
  monthlyPriceMicros: number;
  monthlyPriceGBP: number;
  monthlyCreditMicros: number;
  monthlyCreditGBP: number;
  rateLimitPerMinute: number;
  priority: number;
  maxConcurrency: number;
  canRentGpu: boolean;
  canBuyCredits: boolean;
};

export type CheckoutContext = {
  mode: BillingMode;
  plans: PlanInfo[];
  creditPackages: Array<{ label: string; amountMicros: number; amountGBP: number; priceConfigured?: boolean }>;
  pricesConfigured?: { pro: boolean; max: boolean };
  configIssues?: string[];
};

export type GpuTypeRow = {
  id: string;
  displayName: string;
  vramGb: number;
  hourlyRateMicros: number;
  description: string;
};

export type HealthResponse = {
  status: string;
  service: string;
  version: string;
  time: string;
  database: string;
  billing: BillingMode;
  billingConfigIssues?: string[];
  providers: Array<{ provider: string; displayName: string; configured: boolean }>;
};
