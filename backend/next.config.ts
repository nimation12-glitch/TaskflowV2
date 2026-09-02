import type { NextConfig } from "next";

// The backend self-hosts via the standalone output (Docker / node server.js).
// Vercel never serves the backend, but if it were ever imported there, the
// flag auto-disables (VERCEL=1) exactly like the frontend config.
const isVercel = process.env.VERCEL === "1";

const nextConfig: NextConfig = {
  ...(isVercel ? {} : { output: "standalone" as const }),
  turbopack: { root: process.cwd() },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
