import "server-only";
import fs from "node:fs";
import path from "node:path";
import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { publishAfterCommit } from "@/lib/event-bus";

// Production: real Postgres via DATABASE_URL.
// Local dev without DATABASE_URL: embedded PGlite persisted to ./.data/pglite,
// so the app runs with zero infra. Both share the same schema + migrations.

export type DB = PostgresJsDatabase<typeof schema>;

type Holder = { db: DB; ready: Promise<void> };
const g = globalThis as unknown as { __wheelhouseDb?: Holder };

const MIGRATIONS = path.join(process.cwd(), "drizzle");

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
    return { db, ready };
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
  return { db, ready };
}

function holder(): Holder {
  if (!g.__wheelhouseDb) g.__wheelhouseDb = init();
  return g.__wheelhouseDb;
}

/** Returns the db once migrations have been applied. */
export async function getDb(): Promise<DB> {
  const h = holder();
  await h.ready;
  return h.db;
}

export { schema };
