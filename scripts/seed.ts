/**
 * Creates a demo user/workspace/API key. Run while the app is NOT running when using
 * local PGlite (single-process DB):  pnpm seed
 * Prints the login + API key to stdout.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import * as schema from "../apps/api/src/db/schema";

const EMAIL = process.env.SEED_EMAIL ?? "demo@wheelhouse.local";
const PASSWORD = process.env.SEED_PASSWORD ?? "wheelhouse-demo";

async function getDb() {
  const migrationsFolder = path.join(process.cwd(), "packages", "core", "drizzle");
  if (process.env.DATABASE_URL) {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    return { db, close: () => client.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = path.join(process.cwd(), ".data", "pglite");
  fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db, close: () => client.close() };
}

async function main() {
  const { db, close } = await getDb();
  let [user] = await db.select().from(schema.users).where(eq(schema.users.email, EMAIL));
  let workspaceId: string;
  if (!user) {
    [user] = await db
      .insert(schema.users)
      .values({ email: EMAIL, name: "Demo", passwordHash: await bcrypt.hash(PASSWORD, 10) })
      .returning();
    const [workspace] = await db.insert(schema.workspaces).values({ name: "Demo workspace" }).returning();
    await db.insert(schema.memberships).values({ userId: user.id, workspaceId: workspace.id, role: "owner", tags: ["eng"] });
    workspaceId = workspace.id;
  } else {
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, user.id));
    workspaceId = m.workspaceId;
  }
  const key = `wh_${crypto.randomBytes(24).toString("base64url")}`;
  await db.insert(schema.apiKeys).values({
    workspaceId,
    name: "Claude (seed)",
    prefix: key.slice(0, 10),
    keyHash: crypto.createHash("sha256").update(key).digest("hex"),
    createdBy: user.id,
  });
  // A key reaches only the teams it is scoped to (WH-120): the demo key gets every team the workspace has now.
  await db.execute(sql`insert into api_key_teams (api_key_id, team_id, workspace_id) select k.id, t.id, t.workspace_id from api_keys k join teams t on t.workspace_id = k.workspace_id where k.key_hash = ${crypto.createHash("sha256").update(key).digest("hex")} on conflict do nothing`);
  console.log(JSON.stringify({ email: EMAIL, password: PASSWORD, apiKey: key }, null, 2));
  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
