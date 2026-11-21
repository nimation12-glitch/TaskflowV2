import { LayoutDashboard, CreditCard, Cpu, Users, UserCog, ShieldCheck, LifeBuoy } from "lucide-react";

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
    label: "Organization",
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true },
      { href: "/compute", label: "Compute", icon: Cpu, exact: false },
      { href: "/billing", label: "Billing", icon: CreditCard, exact: false },
      { href: "/team", label: "Team", icon: Users, exact: false },
    ],
  },
  {
    label: "You",
    items: [
      { href: "/account", label: "Account", icon: UserCog, exact: false },
      { href: "/help", label: "Help", icon: LifeBuoy, exact: false },
    ],
  },
];

export const ADMIN_NAV_ITEM: NavItem = { href: "/admin", label: "Admin", icon: ShieldCheck, exact: false };
