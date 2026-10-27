/**
 * Ideas (WH-109) against a real database: create, list newest first by status, comments, re-statusing, promoting to an issue with the
 * trail on both sides, and who may do what. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import type { WorkspaceRole } from "../../db/schema";
import { ServiceError } from "../../common/service-error";
import { createTeam } from "../teams/teams.legacy";
import { testApp } from "../../test/app";
import { IdeasService } from "./ideas.service";
const app = await testApp();
const ideas = app.get(IdeasService);

const RUN = Math.random().toString(16).slice(2, 8);
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
const code = (c: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === c;

let db: Awaited<ReturnType<typeof getDb>>;
let ada: Actor; // owner
let gus: Actor; // guest
let vic: Actor; // viewer
let eve: Actor; // owner of another workspace
let team: { key: string };
let n = 0;

async function person(workspaceId: string, role: WorkspaceRole, name: string): Promise<Actor> {
  const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}-${++n}@example.com`, name, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role });
  return { kind: "human", id: u.id, name, workspaceId };
}

before(async () => {
  db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: `ideas ${RUN}` }).returning();
  const [w2] = await db.insert(schema.workspaces).values({ name: `ideas other ${RUN}` }).returning();
  ada = await person(w.id, "owner", "ada");
  gus = await person(w.id, "guest", "gus");
  vic = await person(w.id, "viewer", "vic");
  eve = await person(w2.id, "owner", "eve");
  team = await createTeam(ada, { name: "Alpha", key: `${L}A` });
});

describe("ideas", () => {
  test("create, list newest first, filter by status, tag a team", async () => {
    const a = await ideas.create(ada, { title: "First", body: "text", team: team.key });
    const b = await ideas.create(ada, { title: "Second" });
    assert.equal(a.status, "new");
    assert.equal(a.team?.key, team.key);
    assert.equal(a.author.name, "ada");
    const all = await ideas.list(ada);
    assert.deepEqual(all.map((i) => i.title).slice(0, 2), ["Second", "First"]);
    await ideas.update(ada, a.id, { status: "parked" });
    assert.deepEqual((await ideas.list(ada, "parked")).map((i) => i.id), [a.id]);
    assert.ok(!(await ideas.list(ada, "new")).some((i) => i.id === a.id));
    assert.ok((await ideas.list(ada, "new")).some((i) => i.id === b.id));
    await assert.rejects(ideas.list(ada, "nope"), code("invalid"));
    await assert.rejects(ideas.create(ada, { title: " " }), code("invalid"));
  });

  test("comments are kept in order", async () => {
    const i = await ideas.create(ada, { title: "Chatty" });
    await ideas.comment(ada, i.id, "one");
    await ideas.comment(ada, i.id, "two");
    const got = await ideas.get(ada, i.id);
    assert.deepEqual(got.comments.map((c) => c.body), ["one", "two"]);
    assert.equal((await ideas.list(ada)).find((x) => x.id === i.id)?.commentCount, 2);
    await assert.rejects(ideas.comment(ada, i.id, ""), code("invalid"));
  });

  test("promoting files an issue that links back, and the idea names the issue", async () => {
    const i = await ideas.create(ada, { title: "Make it faster", body: "Cache the board" });
    await assert.rejects(ideas.promote(ada, i.id, {}), code("invalid"));
    const done = await ideas.promote(ada, i.id, { team: team.key });
    assert.equal(done.status, "promoted");
    assert.match(done.promotedIssue!.ref, new RegExp(`^${team.key}-\\d+$`));
    const filed = (await db.select().from(schema.issues)).find((t) => t.id === done.promotedIssue!.id)!;
    assert.equal(filed.title, "Make it faster");
    assert.ok(filed.body.includes(`/ideas/${i.id}`));
    await assert.rejects(ideas.promote(ada, i.id, { team: team.key }), code("conflict"));
    await assert.rejects(ideas.update(ada, i.id, { status: "new" }), code("invalid"));
    const other = await ideas.create(ada, { title: "x" });
    await assert.rejects(ideas.update(ada, other.id, { status: "promoted" }), code("invalid"));
  });

  test("a stale edit is refused, labels are cleaned, and a promoted idea stays editable", async () => {
    const i = await ideas.create(ada, { title: "Shared", body: "v1" });
    assert.equal(i.version, 1);
    const mine = await ideas.update(ada, i.id, { body: "mine", version: 1 });
    assert.equal(mine.version, 2);
    await assert.rejects(ideas.update(ada, i.id, { body: "theirs", version: 1 }), code("conflict"));
    assert.equal((await ideas.get(ada, i.id)).body, "mine");
    const tagged = await ideas.update(ada, i.id, { labels: [" ux ", "UX", "api"], version: 2 });
    assert.deepEqual(tagged.labels, ["ux", "api"]);
    await assert.rejects(ideas.update(ada, i.id, { labels: "ux" }), code("invalid"));
    const done = await ideas.promote(ada, i.id, { team: team.key });
    assert.equal(done.version, 4);
    assert.equal((await ideas.update(ada, i.id, { title: "Renamed", version: 4 })).title, "Renamed");
  });

  test("an agent files an idea under its own name; Wheelhouse's own work cannot", async () => {
    const agent: Actor = { kind: "agent", id: crypto.randomUUID(), name: "ada (chat)", workspaceId: ada.workspaceId };
    const i = await ideas.create(agent, { title: "From a chat" });
    assert.equal(i.author.name, "ada (chat)");
    assert.ok((await ideas.list(ada)).some((x) => x.id === i.id));
    await assert.rejects(ideas.create({ ...agent, system: true }, { title: "No" }), code("forbidden"));
  });

  test("a guest sees nothing, a viewer reads but cannot write, another workspace gets a 404", async () => {
    const i = await ideas.create(ada, { title: "Private" });
    await assert.rejects(ideas.list(gus), code("not_found"));
    await assert.rejects(ideas.get(gus, i.id), code("not_found"));
    assert.equal((await ideas.get(vic, i.id)).canEdit, false);
    await assert.rejects(ideas.create(vic, { title: "no" }), code("forbidden"));
    await assert.rejects(ideas.comment(vic, i.id, "no"), code("forbidden"));
    await assert.rejects(ideas.get(eve, i.id), code("not_found"));
    assert.ok(!(await ideas.list(eve)).some((x) => x.id === i.id));
  });
});
