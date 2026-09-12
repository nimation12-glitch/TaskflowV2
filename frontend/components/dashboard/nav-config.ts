import { LayoutDashboard, CreditCard, Boxes, Cpu, Users, Settings, ShieldCheck } from "lucide-react";

export const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/dashboard/compute", label: "Compute", icon: Cpu, exact: false },
  { href: "/dashboard/billing", label: "Billing", icon: CreditCard, exact: false },
  { href: "/dashboard/models", label: "Models", icon: Boxes, exact: false },
  { href: "/dashboard/team", label: "Team", icon: Users, exact: false },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, exact: false },
] as const;

export const ADMIN_NAV_ITEM = { href: "/dashboard/admin", label: "Admin", icon: ShieldCheck, exact: false } as const;
