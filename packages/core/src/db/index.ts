import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { publishAfterCommit } from "../lib/event-bus";

// Production: real Postgres via DATABASE_URL.
// Local dev without DATABASE_URL: embedded PGlite persisted to ./.data/pglite,
// so the app runs with zero infra. Both share the same schema + migrations.

export type DB = PostgresJsDatabase<typeof schema>;

type Holder = { db: DB; ready: Promise<void>; close: () => Promise<void> };
const g = globalThis as unknown as { __wheelhouseDb?: Holder };

/**
 * Where the migration files are. WHEELHOUSE_MIGRATIONS_DIR wins; otherwise the layouts we run in are tried in turn: the
 * repository root (packages/core/drizzle), the core package itself, and the flat layout of the container image (./drizzle).
 */
function migrationsDir() {
  const candidates = [process.env.WHEELHOUSE_MIGRATIONS_DIR, path.join(process.cwd(), "packages", "core", "drizzle"), path.join(process.cwd(), "drizzle")].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, "meta", "_journal.json"))) ?? candidates[0];
}
const MIGRATIONS = migrationsDir();
/** The folder of migration files the app applies at boot (the data tools apply the same ones to a fresh target). */
export const migrationsFolder = () => MIGRATIONS;

function init(): Holder {
  const url = process.env.DATABASE_URL;
  if (!url && process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production (the embedded PGlite fallback is for local development only)");
  }
  if (url) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const postgres = require("postgres") as typeof import("postgres");
    const client = postgres(url, { max: 5, prepare: false });
    const db = publishAfterCommit(drizzlePg(client, { schema }));
    const ready = (async () => {
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      await migrate(db, { migrationsFolder: MIGRATIONS });
    })();
    return { db, ready, close: () => client.end() };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle: drizzleLite } = require("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");
  // PGLITE_DIR overrides the location; tests use "memory://" for a throwaway database.
  const dir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  if (!dir.startsWith("memory://")) fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = publishAfterCommit(drizzleLite(client, { schema }) as unknown as DB);
  const ready = (async () => {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder: MIGRATIONS });
  })();
  return { db, ready, close: () => client.close() };
}

function holder(): Holder {
  if (!g.__wheelhouseDb) g.__wheelhouseDb = init();
  return g.__wheelhouseDb;
}

/**
 * Close the connection (PGlite flushes to disk; Postgres drains its pool). Call it on shutdown. The next getDb() opens a
 * fresh one, which is what tests that restart a database rely on.
 */
export async function closeDb(): Promise<void> {
  const h = g.__wheelhouseDb;
  if (!h) return;
  g.__wheelhouseDb = undefined;
  await h.ready.catch(() => undefined);
  await h.close();
}

/** Throws if the database cannot answer a trivial query: for liveness checks. */
export async function pingDb(): Promise<void> {
  const db = await getDb();
  await db.execute(sql`select 1`);
}

/** Returns the db once migrations have been applied. */
export async function getDb(): Promise<DB> {
  const h = holder();
  await h.ready;
  return h.db;
}

export { schema };
