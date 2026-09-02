/**
 * TaskFlow split-distribution generator.
 *
 * Produces .dist/taskflow/{frontend,backend} from the intact single-app
 * workspace WITHOUT touching the live project (preview keeps running):
 *   frontend/ → Vercel SPA (client components + fetch wrapper)
 *   backend/  → self-hosted API (route handlers, server modules, Prisma)
 *
 * Cross-wiring:
 *   frontend fetches  → NEXT_PUBLIC_API_BASE_URL  (+ credentials include)
 *   backend redirects → FRONTEND_BASE_URL         (OAuth finish, email links)
 *   backend CORS/CSRF → TRUSTED_ORIGINS via proxy.ts (rewritten, fresh)
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { patches } from "./split-patches";
import { freshFiles } from "./split-fresh";

const ROOT = "/home/z/my-project";
const OUT = path.join(ROOT, ".dist", "taskflow");
const FE = path.join(OUT, "frontend");
const BE = path.join(OUT, "backend");

function die(msg: string): never {
  console.error(`SPLIT-DIST FATAL: ${msg}`);
  process.exit(1);
}

function copyTo(rel: string, destBase: string) {
  const from = path.join(ROOT, rel);
  if (!existsSync(from)) die(`missing source: ${rel}`);
  cpSync(from, path.join(destBase, rel), { recursive: true });
}

function write(rel: string, content: string, base = OUT) {
  const file = path.join(base, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function addNamedImport(source: string, moduleSpec: string, names: string[]): string {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${moduleSpec.replace("/", "\\/")}["'];?`);
  const m = source.match(re);
  if (m) {
    const existing = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const merged = Array.from(new Set([...existing, ...names])).sort().join(", ");
    return source.replace(re, `import { ${merged} } from "${moduleSpec}";`);
  }
  const lines = source.split("\n");
  const firstImport = lines.findIndex((l) => /^\s*import\s/.test(l));
  if (firstImport === -1) die(`no import line found for fixup of ${moduleSpec}`);
  lines.splice(firstImport, 0, `import { ${names.join(", ")} } from "${moduleSpec}";`);
  return lines.join("\n");
}

// ── 1. clean slate ────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(FE, { recursive: true });
mkdirSync(BE, { recursive: true });
console.log("• clean .dist/taskflow");

// ── 2. copy source trees ──────────────────────────────────────────────────
// Shared configs
for (const rel of ["tsconfig.json", "eslint.config.mjs", ".gitignore", "next-env.d.ts"]) {
  copyTo(rel, FE);
  copyTo(rel, BE);
}
// Frontend-only configs
for (const rel of ["components.json", "tailwind.config.ts", "postcss.config.mjs"]) copyTo(rel, FE);
copyTo("public", FE);
// Backend-only configs
copyTo("bunfig.toml", BE);
copyTo("prisma", BE);
copyTo("scripts", BE);
rmSync(path.join(BE, "scripts", "shots"), { recursive: true, force: true });
copyTo("tests", BE);
mkdirSync(path.join(BE, "db"), { recursive: true });
cpSync(path.join(ROOT, "db", "custom.db"), path.join(BE, "db", "custom.db"));
mkdirSync(path.join(BE, "public"), { recursive: true });
write("backend/public/.gitkeep", "");

// Frontend src
for (const rel of ["src/app/layout.tsx", "src/app/page.tsx", "src/app/globals.css"]) copyTo(rel, FE);
copyTo("src/components", FE);
copyTo("src/hooks", FE);
for (const rel of ["src/lib/client-api.ts", "src/lib/money.ts", "src/lib/utils.ts", "src/types/taskflow.ts"]) copyTo(rel, FE);

// Backend src
copyTo("src/app/api", BE);
copyTo("src/server", BE);
copyTo("src/instrumentation.ts", BE);
for (const rel of ["src/lib/db.ts", "src/lib/money.ts", "src/lib/utils.ts", "src/types/taskflow.ts"]) copyTo(rel, BE);
console.log("• source trees copied");

// ── 3. package.json per app (derived from root — versions stay in sync) ──
const rootPkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const FRONTEND_DEP_DROP = ["@prisma/client", "prisma", "stripe", "z-ai-web-dev-sdk", "uuid", "next-intl"];
const BACKEND_DEP_DROP = [
  "@mdxeditor/editor", "@hookform/resolvers", "@reactuses/core", "@tanstack/react-query",
  "@tanstack/react-table", "class-variance-authority", "date-fns", "embla-carousel-react",
  "framer-motion", "input-otp", "lucide-react", "next-intl", "next-themes", "react-day-picker",
  "react-hook-form", "react-markdown", "react-resizable-panels", "react-syntax-highlighter",
  "recharts", "sonner", "uuid", "vaul", "tailwindcss-animate", "tw-animate-css",
  "@tailwindcss/postcss", "tailwindcss", "sharp",
];
const drop = (deps: Record<string, string>, list: string[], prefix = false) =>
  Object.fromEntries(Object.entries(deps).filter(([k]) => !list.includes(k) && !(prefix && k.startsWith("@radix-ui/"))));

const frontendPkg = {
  name: "taskflow-frontend",
  version: rootPkg.version,
  private: true,
  scripts: {
    dev: "next dev -p 3000",
    build: "next build",
    start: "next start",
    lint: "eslint .",
    typecheck: "tsc --noEmit",
  },
  dependencies: drop(rootPkg.dependencies, FRONTEND_DEP_DROP),
  devDependencies: drop(rootPkg.devDependencies, ["bun-types"]),
};
const backendPkg = {
  name: "taskflow-backend",
  version: rootPkg.version,
  private: true,
  scripts: {
    dev: "next dev -p 4000",
    build: "prisma generate && next build && if [ -d .next/standalone ]; then cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/; fi",
    start: "node .next/standalone/server.js",
    lint: "eslint .",
    typecheck: "tsc --noEmit",
    test: "bun test tests/",
    "db:push": "prisma db push --accept-data-loss",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:reset": "prisma migrate reset",
    "backfill:orgs": "bun scripts/backfill-orgs.ts",
    "stripe:setup": "bun scripts/stripe-setup.ts",
  },
  dependencies: drop(rootPkg.dependencies, BACKEND_DEP_DROP, true),
  devDependencies: drop(rootPkg.devDependencies, ["@tailwindcss/postcss", "tailwindcss", "tw-animate-css"]),
};
write("frontend/package.json", JSON.stringify(frontendPkg, null, 2) + "\n");
write("backend/package.json", JSON.stringify(backendPkg, null, 2) + "\n");
console.log(`• package.json — frontend deps: ${Object.keys(frontendPkg.dependencies).length}, backend deps: ${Object.keys(backendPkg.dependencies).length}`);

// ── 4. filled .env files (everything generatable; secrets marked TODO) ───
const authSecret = randomBytes(32).toString("hex");
const pepper = randomBytes(24).toString("hex");
write("backend/.env", `# TaskFlow Backend — environment (local dev READY; production slots marked)
# Filled with everything generatable. Integrations you own (Stripe, OAuth,
# Resend, Twilio) fail CLOSED with explicit messages until their keys land.

# ── Database ── local SQLite (shipped, seeded) | production: hosted Postgres
DATABASE_URL=file:../db/custom.db
# DATABASE_URL=postgresql://user:pass@host:5432/taskflow?sslmode=require

# ── Core security (freshly generated — rotate any time: openssl rand -hex 32)
AUTH_SECRET=${authSecret}
TASKFLOW_API_KEY_PEPPER=${pepper}

# ── Deployment identity ── set APP_BASE_URL to YOUR backend origin
APP_BASE_URL=https://api.web-agent.org
FRONTEND_BASE_URL=https://taskflow.web-agent.org
TRUSTED_ORIGINS=https://taskflow.web-agent.org,https://api.web-agent.org,http://localhost:3000,http://localhost:4000

# Session cookie — defaults work when frontend+backend share a registrable
# domain (…web-agent.org). Cross-SITE frontend (*.vercel.app) → uncomment:
# SESSION_COOKIE_SAMESITE=none
# SESSION_COOKIE_DOMAIN=.web-agent.org

# ── SMS (dev outbox: codes readable at /api/dev/sms-outbox)
SMS_PROVIDER=dev
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
TWILIO_MESSAGING_SERVICE_SID=

# ── Email (dev transport: console + DB outbox at /api/dev/email-outbox)
RESEND_API_KEY=
EMAIL_FROM=TaskFlow <noreply@taskflow.web-agent.org>

# ── OAuth — callbacks: {APP_BASE_URL}/api/auth/callback/{provider}
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# ── Stripe (create products/prices: bun run stripe:setup)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PRO=
STRIPE_PRICE_MAX=
STRIPE_PRICE_CREDIT_10=
STRIPE_PRICE_CREDIT_25=
STRIPE_PRICE_CREDIT_50=
STRIPE_PRICE_CREDIT_100=

# ── AI model upstreams (optional per provider)
MOONSHOT_API_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=
NVIDIA_API_KEY=
`);
write("frontend/.env", `# TaskFlow Frontend — build-time public configuration
# Local split dev: backend runs on :4000 (cd backend && bun run dev)
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000

# Production — set in Vercel (Project → Settings → Environment Variables):
# NEXT_PUBLIC_API_BASE_URL=https://api.web-agent.org
`);
console.log("• .env files written (backend filled, frontend API base)");

// ── 5. fresh files (proxy, client-api, layout, configs, docs) ────────────
for (const [rel, content] of Object.entries(freshFiles)) write(rel, content);
console.log(`• ${Object.keys(freshFiles).length} fresh files (proxy CORS gate, client-api, layout, Dockerfile, READMEs)`);

// ── 6. apply patches (fail loud on any mismatch) ─────────────────────────
for (const p of patches) {
  const file = p.file.startsWith("backend/") || p.file.startsWith("frontend/") ? path.join(OUT, p.file) : path.join(BE, p.file);
  if (!existsSync(file)) die(`patch target missing: ${p.file}`);
  const src = readFileSync(file, "utf8");
  const count = src.split(p.from).length - 1;
  if (count !== 1) die(`patch anchor hit ${count}× (want 1) in ${p.file}: ${p.from.slice(0, 72)}…`);
  writeFileSync(file, src.replace(p.from, p.to));
}
console.log(`• ${patches.length} patches applied cleanly`);

// ── 7. import fixups (apiUrl into patched components) ────────────────────
for (const rel of ["src/components/taskflow/auth-screens.tsx", "src/components/taskflow/dev-outbox-helper.tsx"]) {
  const file = path.join(FE, rel);
  const fixed = addNamedImport(readFileSync(file, "utf8"), "@/lib/client-api", ["apiUrl"]);
  writeFileSync(file, fixed);
}
console.log("• apiUrl imports wired into patched components");

// ── 8. sanity gates ───────────────────────────────────────────────────────
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = path.join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
for (const f of walk(path.join(FE, "src"))) {
  const src = readFileSync(f, "utf8");
  if (src.includes('from "@/server') || src.includes('from "@/lib/db"')) die(`frontend leak of server code: ${f}`);
}
for (const f of walk(path.join(BE, "src"))) {
  const src = readFileSync(f, "utf8");
  if (src.includes('from "@/components') || src.includes('from "@/hooks"')) die(`backend leak of UI code: ${f}`);
}
if (existsSync(path.join(FE, "src", "app", "api")) || existsSync(path.join(FE, "src", "server"))) {
  die("frontend must not carry api/ or server/ trees");
}
for (const base of [FE, BE]) {
  if (existsSync(path.join(base, ".env.example"))) die(`.env.example must be gone (user request) — found in ${base}`);
}
if (!readFileSync(path.join(BE, "src", "server", "env.ts"), "utf8").includes("frontendBaseUrl")) {
  die("env.ts patch marker missing");
}
console.log("• sanity gates passed (no server leaks in frontend, no UI leaks in backend, no .env.example)");

// ── 9. root .env — fill with everything available (user request) ─────────
const rootEnvPath = path.join(ROOT, ".env");
let rootEnv = readFileSync(rootEnvPath, "utf8");
const ensure = (key: string, value: string) => {
  if (!new RegExp(`^${key}=`, "m").test(rootEnv)) rootEnv += `\n${key}=${value}`;
};
ensure("AUTH_SECRET", authSecret);
ensure("TASKFLOW_API_KEY_PEPPER", pepper);
ensure("SMS_PROVIDER", "dev");
ensure("TRUSTED_ORIGINS", "http://localhost:3000,https://preview-chat-970b43ea-568a-4d4b-b88d-383d3eae4f1d.space-z.ai");
writeFileSync(rootEnvPath, rootEnv);
if (existsSync(path.join(ROOT, ".env.example"))) {
  rmSync(path.join(ROOT, ".env.example"));
  console.log("• root .env filled + .env.example removed (root project)");
}

console.log("\nSPLIT-DIST DONE → .dist/taskflow/{frontend,backend}");
