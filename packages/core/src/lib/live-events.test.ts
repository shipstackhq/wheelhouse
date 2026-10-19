/**
 * Live updates against a real database (WH-1): the service layer's writes reach the event bus once, after they are
 * committed, with the sequence number the log gave them. Runs on in-memory PGlite, or real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import { bus, type StreamEvent } from "./event-bus";
import * as svc from "./service";
import { runTool } from "./tools";
import { teamScope, workspaceScope } from "./stream-scope";

let human: Actor;
let agent: Actor;
let teamId: string;
let workspaceId: string;
let otherWorkspaceId: string;

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: "Live workspace" }).returning();
  const [other] = await db.insert(schema.workspaces).values({ name: "Someone else" }).returning();
  workspaceId = workspace.id;
  otherWorkspaceId = other.id;
  const [user] = await db.insert(schema.users).values({ email: `l-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Lia", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
  const [k] = await db.insert(schema.apiKeys).values({ workspaceId: workspace.id, name: "laptop", prefix: "wh_", keyHash: "live-laptop" }).returning();
  agent = { kind: "agent", id: k.id, name: "laptop", workspaceId: workspace.id };
  human = { kind: "human", id: user.id, name: "Lia", workspaceId: workspace.id };
  teamId = (await svc.createTeam(human, { name: "Live test", key: "LV" })).id;
});

/** Everything the bus carries for the team while `fn` runs. */
async function heard(fn: () => Promise<unknown>, scope: { team: string } | { workspace: string } = { team: teamId }) {
  const got: StreamEvent[] = [];
  const off = bus.subscribe(scope, (e) => got.push(e));
  try {
    await fn();
  } finally {
    off();
  }
  return got;
}

describe("who may watch what", () => {
  test("a team stream resolves for the team's own workspace and is a plain not-found for any other workspace", async () => {
    const db = await getDb();
    const [outsider] = await db.insert(schema.users).values({ email: `o-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Out", passwordHash: "x" }).returning();
    const stranger: Actor = { kind: "human", id: outsider.id, name: "Out", workspaceId: otherWorkspaceId };
    const own = await teamScope("LV")(human);
    assert.deepEqual(own.scope, { team: teamId });
    await assert.rejects(teamScope("LV")(stranger), (e: unknown) => e instanceof svc.ServiceError, "another workspace cannot even tell the team exists");
  });

  test("the workspace stream is always the caller's own workspace, never one named by the request", async () => {
    const { scope } = await workspaceScope()(human);
    assert.deepEqual(scope, { workspace: workspaceId });
  });
});

describe("live events from the service layer", () => {
  test("a write is announced once, with the position the log gave it, by the time the write returns", async () => {
    const db = await getDb();
    let ticket: { ref: string } | undefined;
    const got = await heard(async () => {
      ticket = await svc.createTicket(human, "LV", { title: "Announce me" });
    });
    const created = got.filter((e) => e.type === "ticket.created");
    assert.equal(created.length, 1, "exactly one announcement");
    const [row] = await db.select().from(schema.events).where(eq(schema.events.seq, created[0].seq!));
    assert.equal(row.summary, created[0].summary, "its seq points at the committed row");
    assert.match(created[0].summary!, new RegExp(ticket!.ref));
    assert.equal(created[0].actorName, "Lia");
    assert.equal(created[0].teamId, teamId);
  });

  test("every kind of write announces itself: move, comment, edit", async () => {
    const t = await svc.createTicket(human, "LV", { title: "Moves around" });
    const got = await heard(async () => {
      await svc.moveTicket(human, t.ref, "Todo");
      await svc.addComment(human, t.ref, "hello");
      await svc.updateTicket(human, t.ref, { title: "Moved and renamed" });
    });
    const types = got.map((e) => e.type);
    for (const want of ["ticket.moved", "comment.created", "ticket.updated"]) assert.ok(types.includes(want), `${want} was announced`);
    const seqs = got.map((e) => e.seq!);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "in log order");
  });

  test("an agent's write through the tool layer is announced the same way", async () => {
    const got = await heard(() => runTool(agent, "create_ticket", { project: "LV", title: "From an agent" }));
    assert.ok(got.some((e) => e.type === "ticket.created" && e.actorKind === "agent"));
  });

  test("a transaction that rolls back announces nothing and writes nothing", async () => {
    const db = await getDb();
    const before = (await db.select().from(schema.events).where(eq(schema.events.teamId, teamId))).length;
    const got = await heard(async () => {
      await assert.rejects(
        db.transaction(async (tx) => {
          await svc.emit(tx, human, teamId, { type: "ticket.created", entity: "ticket", entityId: teamId, summary: "never happened" });
          throw new Error("boom");
        }),
        /boom/,
      );
    });
    assert.deepEqual(got, []);
    assert.equal((await db.select().from(schema.events).where(eq(schema.events.teamId, teamId))).length, before);
  });

  test("a watcher of the workspace hears the team, and a watcher of another workspace hears nothing", async () => {
    const mine: StreamEvent[] = [];
    const theirs: StreamEvent[] = [];
    const a = bus.subscribe({ workspace: workspaceId }, (e) => mine.push(e));
    const b = bus.subscribe({ workspace: otherWorkspaceId }, (e) => theirs.push(e));
    await svc.createTicket(human, "LV", { title: "Private to the workspace" });
    a();
    b();
    assert.ok(mine.length > 0);
    assert.deepEqual(theirs, [], "another workspace's stream never sees it");
  });

  test("an agent acking its queue sends a transient signal, so the Bots menu count can update", async () => {
    const got = await heard(() => runTool(agent, "ack_changes", { project: "LV", seq: 1 }));
    const q = got.filter((e) => e.type === "queue.changed");
    assert.equal(q.length, 1);
    assert.equal(q[0].seq, undefined, "it is not a row in the log");
  });

  test("subscribers do not pile up: after the watchers leave, the bus is empty", async () => {
    await heard(() => svc.createTicket(human, "LV", { title: "Nobody watching after this" }));
    assert.equal(bus.size(), 0);
  });
});
