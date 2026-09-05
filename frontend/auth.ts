import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { bootstrapOrganization, getMembershipsForUser } from "@/lib/backend-internal";

// --- Provider configuration is only wired up when real credentials exist.
// A provider with missing env vars is simply omitted from the list, so its
// button never renders — we never fake a working OAuth provider (see
// docs/AGENTS.md §4).
const providers: NextAuthConfig["providers"] = [
  Credentials({
    name: "Email and password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      const email = credentials?.email as string | undefined;
      const password = credentials?.password as string | undefined;
      if (!email || !password) return null;

      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (!user?.passwordHash) return null; // no password set (OAuth-only account)

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return null;

      return { id: user.id, email: user.email, name: user.name, image: user.image };
    },
  }),
];

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Minimal scope — identity only, never Drive/Gmail (docs/AGENTS.md §13).
      authorization: { params: { scope: "openid email profile" } },
    })
  );
}

if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
  providers.push(
    MicrosoftEntraID({
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      issuer: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID ?? "common"}/v2.0`,
    })
  );
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    })
  );
}

export const config: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  providers,
  // Credentials provider is incompatible with database-persisted sessions in
  // Auth.js, so we use JWT sessions everywhere for consistency. The JWT is
  // encrypted (JWE) and HttpOnly/Secure-cookied by NextAuth itself.
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: {
    signIn: "/login",
    newUser: "/dashboard", // onboarding lands straight in the just-created workspace
  },
  events: {
    // Fires exactly once, only for OAuth sign-ups where the Prisma adapter
    // itself inserts the User row. Credentials-based signups create the user
    // in app/api/signup/route.ts and bootstrap there instead (adapter never
    // touches that path). Idempotent on the backend either way.
    async createUser({ user }) {
      if (!user.id || !user.email) return;
      await bootstrapOrganization({ userId: user.id, displayName: user.name, email: user.email });
    },
  },
  callbacks: {
    async jwt({ token, user, trigger }) {
      // On sign-in (or forced refresh), attach this user's organization
      // memberships so the rest of the app has org/role without a DB hit
      // on every request. Memberships live in the FastAPI backend, not Prisma.
      if (user?.id) {
        token.userId = user.id;
      }
      if (user?.id || trigger === "update") {
        try {
          const memberships = await getMembershipsForUser(token.userId as string);
          // Default to the first membership (the workspace created at signup).
          // Full multi-org switching UI can set an explicit activeOrganizationId
          // via the `update()` trigger later.
          token.memberships = memberships;
          if (!token.activeOrganizationId && memberships.length > 0) {
            token.activeOrganizationId = memberships[0].organization_id;
            token.activeRole = memberships[0].role;
          }
        } catch {
          // Backend unavailable — keep any previously-cached memberships
          // rather than locking the user out of a page that doesn't need them.
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { id?: string }).id = token.userId as string;
      }
      session.activeOrganizationId = token.activeOrganizationId as string | undefined;
      session.activeRole = token.activeRole as "OWNER" | "ADMIN" | "MEMBER" | undefined;
      session.memberships = (token.memberships as typeof session.memberships) ?? [];
      return session;
    },
  },
  trustHost: true,
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
