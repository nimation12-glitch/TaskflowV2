import type { NextConfig } from "next";

// Frontend-only deployment (Vercel): no standalone output, no API routes.
// turbopack.root pins the project boundary — without it Turbopack can walk
// up a parent directory (.git/lockfile) and compile files that do not
// belong to this app.
const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
