import { LayoutDashboard, CreditCard, Boxes, Cpu, Users, UserCog, ShieldCheck, KeyRound, LifeBuoy } from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact: boolean;
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true },
      { href: "/compute", label: "Compute", icon: Cpu, exact: false },
      { href: "/billing", label: "Billing", icon: CreditCard, exact: false },
      { href: "/models", label: "Models", icon: Boxes, exact: false },
      { href: "/team", label: "Team", icon: Users, exact: false },
    ],
  },
  {
    label: "You",
    items: [
      { href: "/api-keys", label: "API keys", icon: KeyRound, exact: false },
      { href: "/account", label: "Account", icon: UserCog, exact: false },
      { href: "/help", label: "Help", icon: LifeBuoy, exact: false },
    ],
  },
];

export const ADMIN_NAV_ITEM: NavItem = { href: "/admin", label: "Admin", icon: ShieldCheck, exact: false };
