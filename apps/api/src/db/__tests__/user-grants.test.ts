/**
 * Device grants (WH-159, ADR-25), against a real database: the lookup never returns a revoked grant, the token hash is unique, and
 * deleting the grant, the workspace, the membership or the user removes the workspace rows. Runs on an in-memory PGlite.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "..";
import { AuthRepository } from "../../modules/auth/auth.repository";
import { testApp } from "../../test/app";
const app = await testApp();

const RUN = Math.random().toString(16).slice(2, 8);
const code = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code;

let db: Awaited<ReturnType<typeof getDb>>;
let repo: AuthRepository;
let userId: string;
let otherUserId: string;
let ws1: string;
let ws2: string;

const grant = async (hash: string, v: Partial<typeof schema.userGrants.$inferInsert> = {}) => {
  const [g] = await db.insert(schema.userGrants).values({ userId, deviceName: "laptop", tokenHash: `${hash}-${RUN}`, prefix: "wg_abc", ...v }).returning();
  return g;
};
const reach = (grantId: string) => db.select().from(schema.userGrantWorkspaces).where(eq(schema.userGrantWorkspaces.grantId, grantId));

before(async () => {
  db = await getDb();
  repo = app.get(AuthRepository);
  const mkUser = async (n: string) => (await db.insert(schema.users).values({ email: `${n}-${RUN}@example.com`, name: n, passwordHash: "x" }).returning())[0].id;
  const mkWs = async (n: string) => (await db.insert(schema.workspaces).values({ name: `${n} ${RUN}` }).returning())[0].id;
  userId = await mkUser("grantee");
  otherUserId = await mkUser("other");
  ws1 = await mkWs("g1");
  ws2 = await mkWs("g2");
  await db.insert(schema.memberships).values([{ userId, workspaceId: ws1 }, { userId, workspaceId: ws2 }]);
});

describe("user grants", () => {
  test("the lookup returns a live grant and never a revoked one", async () => {
    const g = await grant("live");
    assert.equal(g.allWorkspaces, false);
    assert.equal((await repo.activeGrantByHash(g.tokenHash))?.id, g.id);
    await db.update(schema.userGrants).set({ revokedAt: new Date() }).where(eq(schema.userGrants.id, g.id));
    assert.equal(await repo.activeGrantByHash(g.tokenHash), undefined);
    assert.equal(await repo.activeGrantByHash("no-such-hash"), undefined);
  });

  test("the token hash is unique", async () => {
    const g = await grant("dup");
    await assert.rejects(grant("dup"), (e) => code(e) === "23505");
    assert.ok(g.id);
  });

  test("a chosen list holds only workspaces the person is a member of", async () => {
    const g = await grant("list");
    await db.insert(schema.userGrantWorkspaces).values({ grantId: g.id, workspaceId: ws1, userId });
    assert.deepEqual(await repo.grantWorkspaceIds(g.id), [ws1]);
    const [foreign] = await db.insert(schema.workspaces).values({ name: `foreign ${RUN}` }).returning();
    await assert.rejects(db.insert(schema.userGrantWorkspaces).values({ grantId: g.id, workspaceId: foreign.id, userId }), (e) => code(e) === "23503");
  });

  test("a row cannot point at another person's grant", async () => {
    const g = await grant("owned");
    await assert.rejects(db.insert(schema.userGrantWorkspaces).values({ grantId: g.id, workspaceId: ws1, userId: otherUserId }), (e) => code(e) === "23503");
  });

  test("deleting the grant, the membership or the workspace removes the rows", async () => {
    const g = await grant("cascade");
    await db.insert(schema.userGrantWorkspaces).values([{ grantId: g.id, workspaceId: ws1, userId }, { grantId: g.id, workspaceId: ws2, userId }]);
    await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, ws2)));
    assert.deepEqual(await repo.grantWorkspaceIds(g.id), [ws1]);
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws1));
    assert.deepEqual(await reach(g.id), []);
    await db.delete(schema.userGrants).where(eq(schema.userGrants.id, g.id));
  });

  test("deleting the user removes their grants and rows", async () => {
    const [u] = await db.insert(schema.users).values({ email: `gone-${RUN}@example.com`, name: "gone", passwordHash: "x" }).returning();
    const [w] = await db.insert(schema.workspaces).values({ name: `gone ${RUN}` }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: w.id });
    const [g] = await db.insert(schema.userGrants).values({ userId: u.id, deviceName: "d", tokenHash: `gone-${RUN}`, prefix: "wg_x" }).returning();
    await db.insert(schema.userGrantWorkspaces).values({ grantId: g.id, workspaceId: w.id, userId: u.id });
    await db.delete(schema.users).where(eq(schema.users.id, u.id));
    assert.deepEqual(await reach(g.id), []);
    assert.equal(await repo.activeGrantByHash(`gone-${RUN}`), undefined);
  });
});
