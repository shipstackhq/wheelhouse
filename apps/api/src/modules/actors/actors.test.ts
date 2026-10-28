/**
 * The actor resolver against a real database: a mixed thread (a person with a picture, a roster agent, a plain api key, a deleted
 * user) resolves to the right faces with one query per kind, and an agent id from another workspace never lends its face.
 * Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, schema } from "../../db";
import { Database } from "../../platform/database/database";
import { testApp } from "../../test/app";
import { ActorsService } from "./actors.service";
const app = await testApp();

const RUN = Math.random().toString(16).slice(2, 8);

describe("ActorsService.resolve", () => {
  test("a mixed thread: person, roster agent, plain key, deleted user", async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "Actors A" }).returning();
    const [other] = await db.insert(schema.workspaces).values({ name: "Actors B" }).returning();
    const [ada] = await db.insert(schema.users).values({ email: `ada-${RUN}@example.com`, name: "Ada", passwordHash: "x", avatarKey: "avatars/u/abc123.png" }).returning();
    const [plain] = await db.insert(schema.users).values({ email: `plain-${RUN}@example.com`, name: "Plain", passwordHash: "x" }).returning();
    const [agent] = await db.insert(schema.workspaceAgents).values({ workspaceId: ws.id, slug: `backend-${RUN}`, source: "catalog", catalogSlug: "backend" }).returning();
    const [foreign] = await db.insert(schema.workspaceAgents).values({ workspaceId: other.id, slug: `backend-${RUN}`, source: "catalog", catalogSlug: "backend" }).returning();
    const [key] = await db.insert(schema.apiKeys).values({ workspaceId: ws.id, name: "laptop", prefix: "wh_x", keyHash: `h-${RUN}` }).returning();

    // Count the selects the resolver issues.
    const real = app.get(Database);
    let selects = 0;
    const counting = { get q() { return { select: (...a: unknown[]) => { selects++; return (real.q.select as (...x: unknown[]) => unknown)(...a); } }; } } as unknown as Database;
    const actors = new ActorsService(counting);

    const out = await actors.resolve(ws.id, [
      { kind: "human", id: ada.id, name: "Ada (old name)" },
      { kind: "human", id: plain.id, name: "Plain" },
      { kind: "agent", id: agent.id, name: "Bram" },
      { kind: "agent", id: key.id, name: "Claude on laptop" },
      { kind: "agent", id: foreign.id, name: "Elsewhere" },
      { kind: "human", id: randomUUID(), name: "Gone User" },
      { kind: "human", id: null, name: "No Id" },
      { kind: "agent", id: "not-a-uuid", name: "Device" },
      { kind: "human", id: ada.id, name: "Ada" },
    ]);

    assert.equal(selects, 2, "one query per kind");
    assert.deepEqual(out[0], { kind: "human", id: ada.id, name: "Ada", avatar: { type: "image", url: `/api/app/images/users/${ada.id}?v=abc123` } });
    assert.deepEqual(out[1], { kind: "human", id: plain.id, name: "Plain", avatar: null });
    assert.deepEqual(out[2], { kind: "agent", id: agent.id, name: "Bram", avatar: { type: "generated", style: "notionists", seed: "bram" } });
    assert.deepEqual(out[3], { kind: "agent", id: key.id, name: "Claude on laptop", avatar: null });
    assert.deepEqual(out[4], { kind: "agent", id: foreign.id, name: "Elsewhere", avatar: null }, "another workspace's agent lends no face");
    assert.deepEqual(out[5], { kind: "human", id: null, name: "Gone User", avatar: null }, "a deleted user keeps the stored name");
    assert.deepEqual(out[6], { kind: "human", id: null, name: "No Id", avatar: null });
    assert.deepEqual(out[7], { kind: "agent", id: "not-a-uuid", name: "Device", avatar: null });
    assert.equal(out[8].name, "Ada");
  });

  test("author_agent_id wins over author_id: a run key's comment gets the roster agent's face; a deleted agent falls back", async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "Actors C" }).returning();
    const [agent] = await db.insert(schema.workspaceAgents).values({ workspaceId: ws.id, slug: `backend-${RUN}`, source: "catalog", catalogSlug: "backend" }).returning();
    const actors = new ActorsService(app.get(Database));
    const [viaKey, gone] = await actors.resolve(ws.id, [
      { kind: "agent", id: randomUUID(), agentId: agent.id, name: "Bram" },
      { kind: "agent", id: randomUUID(), agentId: null, name: "Old agent" },
    ]);
    assert.equal(viaKey.id, agent.id);
    assert.equal(viaKey.avatar?.type, "generated");
    assert.deepEqual(gone.avatar, null);
  });

  test("no refs, no queries", async () => {
    let selects = 0;
    const counting = { get q() { selects++; return {}; } } as unknown as Database;
    assert.deepEqual(await new ActorsService(counting).resolve("w", []), []);
    assert.equal(selects, 0);
  });
});
