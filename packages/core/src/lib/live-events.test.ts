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
import { projectScope, teamScope } from "./stream-scope";

let human: Actor;
let agent: Actor;
let projectId: string;
let teamId: string;
let otherTeamId: string;

before(async () => {
  const db = await getDb();
  const [team] = await db.insert(schema.teams).values({ name: "Live team" }).returning();
  const [other] = await db.insert(schema.teams).values({ name: "Someone else" }).returning();
  teamId = team.id;
  otherTeamId = other.id;
  const [user] = await db.insert(schema.users).values({ email: `l-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Lia", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, teamId: team.id, role: "owner" });
  const [k] = await db.insert(schema.apiKeys).values({ teamId: team.id, name: "laptop", prefix: "wh_", keyHash: "live-laptop" }).returning();
  agent = { kind: "agent", id: k.id, name: "laptop", teamId: team.id };
  human = { kind: "human", id: user.id, name: "Lia", teamId: team.id };
  projectId = (await svc.createProject(human, { name: "Live test", key: "LV" })).id;
});

/** Everything the bus carries for the project while `fn` runs. */
async function heard(fn: () => Promise<unknown>, scope: { project: string } | { team: string } = { project: projectId }) {
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
  test("a project stream resolves for the project's own team and is a plain not-found for any other team", async () => {
    const db = await getDb();
    const [outsider] = await db.insert(schema.users).values({ email: `o-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Out", passwordHash: "x" }).returning();
    const stranger: Actor = { kind: "human", id: outsider.id, name: "Out", teamId: otherTeamId };
    const own = await projectScope("LV")(human);
    assert.deepEqual(own.scope, { project: projectId });
    await assert.rejects(projectScope("LV")(stranger), (e: unknown) => e instanceof svc.ServiceError, "another team cannot even tell the project exists");
  });

  test("the team stream is always the caller's own team, never one named by the request", async () => {
    const { scope } = await teamScope()(human);
    assert.deepEqual(scope, { team: teamId });
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
    assert.equal(created[0].projectId, projectId);
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
    const before = (await db.select().from(schema.events).where(eq(schema.events.projectId, projectId))).length;
    const got = await heard(async () => {
      await assert.rejects(
        db.transaction(async (tx) => {
          await svc.emit(tx, human, projectId, { type: "ticket.created", entity: "ticket", entityId: projectId, summary: "never happened" });
          throw new Error("boom");
        }),
        /boom/,
      );
    });
    assert.deepEqual(got, []);
    assert.equal((await db.select().from(schema.events).where(eq(schema.events.projectId, projectId))).length, before);
  });

  test("a watcher of the team hears the project, and a watcher of another team hears nothing", async () => {
    const mine: StreamEvent[] = [];
    const theirs: StreamEvent[] = [];
    const a = bus.subscribe({ team: teamId }, (e) => mine.push(e));
    const b = bus.subscribe({ team: otherTeamId }, (e) => theirs.push(e));
    await svc.createTicket(human, "LV", { title: "Private to the team" });
    a();
    b();
    assert.ok(mine.length > 0);
    assert.deepEqual(theirs, [], "another team's stream never sees it");
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
