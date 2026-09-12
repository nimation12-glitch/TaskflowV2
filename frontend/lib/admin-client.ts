import "server-only";
import { backendJson } from "@/lib/backend-client";

export type PlanCode = "FREE" | "PRO" | "MAX";

export type AdminOrgSummary = {
  id: string;
  name: string;
  plan_code: PlanCode;
  wallet_balance_micros: number;
  member_count: number;
  active_gpu_rental_count: number;
  created_at: string;
};

export type AdminOrgMember = { user_id: string; role: "OWNER" | "ADMIN" | "MEMBER" };

export type AdminCreditTransaction = {
  type: string;
  amount_micros: number;
  description: string;
  created_at: string;
};

export type AdminOrgDetail = AdminOrgSummary & {
  members: AdminOrgMember[];
  recent_credit_transactions: AdminCreditTransaction[];
};

export function getAdminOrganizations() {
  return backendJson<{ organizations: AdminOrgSummary[] }>("/admin/organizations");
}

export function getAdminOrganization(id: string) {
  return backendJson<AdminOrgDetail>(`/admin/organizations/${id}`);
}

/** Grants (positive) or deducts (negative) credits as an audited ledger entry — never a raw balance edit. */
export function adjustOrganizationCredits(id: string, input: { amount_micros: number; reason: string }) {
  return backendJson<{ new_balance_micros: number }>(`/admin/organizations/${id}/credits`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Force-changes plan without Stripe checkout — support/comped-account use only. */
export function changeOrganizationPlan(id: string, planCode: PlanCode) {
  return backendJson<AdminOrgDetail>(`/admin/organizations/${id}/plan`, {
    method: "POST",
    body: JSON.stringify({ plan_code: planCode }),
  });
}
