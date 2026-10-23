import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The environment, before the database or any of the server's libraries run. The same variables as the Next app (DATABASE_URL, PGLITE_DIR,
 * the GITHUB_* settings, ...), plus PORT (default 3000) and HOST (default 0.0.0.0).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "..", "..", "..");

export function configureEnvironment() {
  // Like Next.js, read .env.local then .env from the repository root; variables already set always win.
  for (const f of [".env.local", ".env"]) {
    const file = path.join(REPO_ROOT, f);
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
  // Wherever the process is started from, find the migrations and (without DATABASE_URL) the development database.
  process.env.WHEELHOUSE_MIGRATIONS_DIR ??= path.join(REPO_ROOT, "apps", "api", "drizzle");
  if (!process.env.DATABASE_URL) process.env.PGLITE_DIR ??= path.join(REPO_ROOT, ".data", "pglite");
}
