import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user?: DefaultSession["user"] & { id?: string };
    activeOrganizationId?: string;
    activeRole?: "OWNER" | "ADMIN" | "MEMBER";
    memberships: { organization_id: string; role: "OWNER" | "ADMIN" | "MEMBER" }[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    activeOrganizationId?: string;
    activeRole?: "OWNER" | "ADMIN" | "MEMBER";
    memberships?: { organization_id: string; role: "OWNER" | "ADMIN" | "MEMBER" }[];
  }
}
