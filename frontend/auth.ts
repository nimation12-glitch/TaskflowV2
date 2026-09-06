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
      if (!user?.passwordHash) return null;

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
  debug: true,
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  pages: {
    signIn: "/login",
    newUser: "/dashboard",
  },
  events: {
    async createUser({ user }) {
      if (!user.id || !user.email) return;
      try {
        await bootstrapOrganization({ userId: user.id, displayName: user.name, email: user.email });
      } catch (err) {
        console.error("[taskflow] bootstrapOrganization failed in createUser event:", err);
        throw err;
      }
    },
  },
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user?.id) {
        token.userId = user.id;
      }
      if (user?.id || trigger === "update" || !token.activeOrganizationId) {
        try {
          const memberships = await getMembershipsForUser(token.userId as string);
          token.memberships = memberships;
          if (!token.activeOrganizationId && memberships.length > 0) {
            token.activeOrganizationId = memberships[0].organization_id;
            token.activeRole = memberships[0].role;
          }
        } catch (err) {
          console.error("[taskflow] getMembershipsForUser failed in jwt callback:", err);
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