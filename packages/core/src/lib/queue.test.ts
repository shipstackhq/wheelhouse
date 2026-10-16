/**
 * Per-session queue cursors (WH-42). Runs against a throwaway in-memory PGlite (`pnpm test`), or against a real
 * Postgres with TEST_DATABASE_URL=postgres://... and `--test-force-exit`.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; // a real Postgres, as in CI
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import * as svc from "./service";
import { runTool } from "./tools";
import { agentQueues } from "./metrics";
import { briefing } from "./briefing";
import { bucketOf } from "./session-buckets";

type Changes = Awaited<ReturnType<typeof svc.getChanges>>;

let human: Actor;
let key: Actor;
let otherKey: Actor;
let ticketRef: string;

const as = (a: Actor, tool: string, args: Record<string, unknown>) => runTool(a, tool, { project: "QQ", ...args });
const changes = (a: Actor, session?: string) => as(a, "get_changes", session ? { session } : {}) as Promise<Changes>;
const seqs = (c: Changes) => c.changes.map((e) => e.seq);

before(async () => {
  const db = await getDb();
  const [team] = await db.insert(schema.teams).values({ name: "Test team" }).returning();
  const [user] = await db.insert(schema.users).values({ email: `t-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Tess", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, teamId: team.id, role: "owner" });
  const mkKey = async (name: string) => {
    const [k] = await db.insert(schema.apiKeys).values({ teamId: team.id, name, prefix: "wh_", keyHash: name }).returning();
    return { kind: "agent", id: k.id, name, teamId: team.id } satisfies Actor;
  };
  key = await mkKey("laptop");
  otherKey = await mkKey("ci");
  human = { kind: "human", id: user.id, name: "Tess", teamId: team.id };
  await svc.createProject(human, { name: "Queue test", key: "QQ" });
  ticketRef = (await svc.createTicket(human, "QQ", { title: "Shared ticket" })).ref;
});

describe("per-session queue cursors", () => {
  test("acking in one session doesn't hide the change from another session on the same key", async () => {
    const a = await changes(key, "sess-A");
    const b = await changes(key, "sess-B");
    assert.ok(a.total > 0, "A sees the team's changes");
    assert.deepEqual(seqs(b), seqs(a), "B starts with the same queue");

    await as(key, "ack_changes", { session: "sess-A", seq: a.latestSeq });
    assert.equal((await changes(key, "sess-A")).total, 0, "A's queue is empty after its ack");
    assert.deepEqual(seqs(await changes(key, "sess-B")), seqs(b), "B still has every change");
  });

  test("a session's own writes are hidden from it but visible to sibling sessions", async () => {
    const before = (await changes(key, "sess-A")).latestSeq;
    await as(key, "update_ticket", { ticket: ticketRef, priority: "high", session: "sess-A" });

    const a = await changes(key, "sess-A");
    assert.equal(a.changes.filter((e) => e.seq > before).length, 0, "A doesn't see its own edit");

    const b = await changes(key, "sess-B");
    const edit = b.changes.find((e) => e.type === "ticket.updated");
    assert.ok(edit, "B sees A's edit");
    assert.equal(edit.sessionId, "sess-A", "the event records which session wrote it");
  });

  test("calls without a session keep today's key-level behaviour", async () => {
    const k = await changes(key);
    assert.equal(k.session, null);
    assert.ok(!k.changes.some((e) => e.actorKind === "agent" && e.actorId === key.id), "the key's own writes stay hidden");
  });

  test("the key-level cursor follows the furthest ack, and new sessions start there", async () => {
    const b = await changes(key, "sess-B");
    await as(key, "ack_changes", { session: "sess-B", seq: b.latestSeq });
    assert.equal((await changes(key)).total, 0, "key-level cursor caught up with B");

    const fresh = await changes(key, "sess-C");
    assert.equal(fresh.total, 0, "a new session doesn't replay history other sessions handled");

    await svc.addComment(human, ticketRef, "new work for the agents");
    const after = await changes(key, "sess-C");
    assert.deepEqual(after.changes.map((e) => e.type), ["comment.created"], "but it gets changes from then on");
  });

  test("a session registered by another key is refused", async () => {
    await assert.rejects(changes(otherKey, "sess-A"), (e: unknown) => e instanceof svc.ServiceError && e.code === "forbidden");
    await assert.rejects(
      as(otherKey, "update_ticket", { ticket: ticketRef, title: "hijack", session: "sess-A" }),
      (e: unknown) => e instanceof svc.ServiceError && e.code === "forbidden",
    );
  });

  test("the Bots menu reports each active session's depth", async () => {
    await svc.addComment(human, ticketRef, "one more");
    const [laptop] = (await svc.queueStatus(human, "QQ")).filter((q) => q.id === key.id);
    assert.deepEqual(laptop.sessions.map((s) => s.id).sort(), ["sess-A", "sess-B", "sess-C"]);
    assert.equal(laptop.pending, Math.max(...laptop.sessions.map((s) => s.pending)), "key pending is the furthest-behind session");
  });

  test("mark all seen resets every session cursor of the key", async () => {
    await svc.markAllSeen(human, { keyId: key.id, projectRef: "QQ" });
    for (const s of ["sess-A", "sess-B", "sess-C"]) assert.equal((await changes(key, s)).total, 0, `${s} is caught up`);
  });
});

describe("session breakdown (WH-45)", () => {
  test("queueStatus and the dashboard feed carry each session's branch, ticket and own queue", async () => {
    const db = await getDb();
    const [t] = await db.select().from(schema.tickets).where(eq(schema.tickets.title, "Shared ticket"));
    await as(key, "session_end", { session: "sess-A" }); // a cleanly ended session drops out of the lists
    await db.update(schema.workSessions).set({ branch: "feature/x", ticketId: t.id }).where(eq(schema.workSessions.id, "sess-B"));
    await svc.addComment(human, ticketRef, "fresh");

    const status = (await svc.queueStatus(human, "QQ")).find((q) => q.id === key.id)!;
    const b = status.sessions.find((s) => s.id === "sess-B")!;
    assert.equal(b.branch, "feature/x");
    assert.equal(b.ticket, ticketRef);
    assert.equal(status.sessions.find((s) => s.id === "sess-C")!.ticket, null, "unknown ticket stays null");
    assert.ok(!status.sessions.some((s) => s.id === "sess-A"), "an ended session is no longer listed");

    const row = (await agentQueues(human)).find((a) => a.id === key.id)!;
    assert.equal(row.sessions.length, 2, "the dashboard gets the active sessions (B and C), not just the key's total");
    assert.ok(row.sessions.every((s) => s.projectKey === "QQ" && typeof s.lastSeenAt === "string"), "serialisable, tagged with the project");
    assert.deepEqual(
      row.sessions.map((s) => s.lastSeenAt),
      [...row.sessions.map((s) => s.lastSeenAt)].sort().reverse(),
      "most recently seen first",
    );
  });

  test("acking in one session changes only that session's queued count", async () => {
    const before = (await svc.queueStatus(human, "QQ")).find((q) => q.id === key.id)!;
    const b = before.sessions.find((s) => s.id === "sess-B")!;
    const c = before.sessions.find((s) => s.id === "sess-C")!;
    assert.ok(b.pending > 0 && c.pending > 0, "both have something queued");

    await as(key, "ack_changes", { session: "sess-B", seq: (await changes(key, "sess-B")).latestSeq });

    const after = (await svc.queueStatus(human, "QQ")).find((q) => q.id === key.id)!;
    assert.equal(after.sessions.find((s) => s.id === "sess-B")!.pending, 0);
    assert.equal(after.sessions.find((s) => s.id === "sess-C")!.pending, c.pending, "C is untouched");
  });
});

describe("the model is never asked to handle the session id (ADR-5)", () => {
  test("neither the briefing nor the get_changes description mentions passing a session", async () => {
    await svc.addComment(human, ticketRef, "something to report");
    const { markdown } = await briefing({ ...key, sessionId: "sess-C" }, "QQ");
    assert.ok(markdown.includes("Since you last looked"), "the session's queue still shows up");
    assert.ok(!/session/i.test(markdown.split("## Since you last looked")[1] ?? ""), "but without asking the model to pass an id");
    assert.ok(!markdown.includes("Your Wheelhouse session is"));

    const def = (await import("./tools")).listToolDefs().find((t) => t.name === "get_changes")!;
    assert.ok(!/Pass `session`/.test(def.description));
  });
});

// ───────────── WH-48: recency buckets, removal, cleanup, reconnect ─────────────

const H = 3600e3;
const D = 24 * H;
type Resumable = Changes & { session_removed?: { removedAt: string | null; missedChanges: number; next: string } };

describe("session recency, removal and reconnect (WH-48)", () => {
  let projectId: string;
  const insert = async (id: string, over: { lastSeenAgo?: number; lastSeq?: number | null; removedAgo?: number } = {}) => {
    const db = await getDb();
    await db.insert(schema.workSessions).values({
      id,
      projectId,
      apiKeyId: key.id,
      actorName: "laptop",
      lastSeq: over.lastSeq === undefined ? 0 : over.lastSeq,
      lastSeenAt: new Date(Date.now() - (over.lastSeenAgo ?? 0)),
      removedAt: over.removedAgo == null ? null : new Date(Date.now() - over.removedAgo),
    });
  };
  const row = async (id: string) => (await (await getDb()).select().from(schema.workSessions).where(eq(schema.workSessions.id, id)))[0];
  const listed = async () => (await svc.queueStatus(human, "QQ")).find((q) => q.id === key.id)!;

  before(async () => {
    const db = await getDb();
    [{ id: projectId }] = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.key, "QQ"));
  });

  test("every call that names a session counts as activity, reads included", async () => {
    await insert("s-idle", { lastSeenAgo: 8 * H });
    assert.equal((await listed()).sessions.find((s) => s.id === "s-idle")!.bucket, "h12", "8h idle is in 6–12h");
    await changes(key, "s-idle"); // a plain read
    assert.equal((await listed()).sessions.find((s) => s.id === "s-idle")!.bucket, "h6", "reading its queue made it active");
    assert.equal(bucketOf((await row("s-idle")).lastSeenAt), "h6");
  });

  test("sessions land in their recency bucket and the key's queued count only looks at the last 6 hours", async () => {
    await insert("s-day", { lastSeenAgo: 30 * H, lastSeq: 0 }); // far behind, but dead-ish
    await insert("s-fresh", { lastSeenAgo: 1 * H, lastSeq: null }); // never read its queue
    const k = await listed();
    const by = (id: string) => k.sessions.find((s) => s.id === id)!;
    assert.equal(by("s-day").bucket, "d7");
    assert.ok(by("s-day").pending > 0, "the old session really is behind");
    assert.equal(by("s-fresh").reading, false);
    assert.equal(by("s-fresh").pending, 0, "no cursor of its own: not reported as behind or caught up");
    const recentMax = Math.max(...k.sessions.filter((s) => s.bucket === "h6").map((s) => s.pending));
    assert.equal(k.pending, recentMax, "the 30h-old session doesn't inflate the key's count");
  });

  test("only teammates can remove a session; it disappears everywhere and nobody else's queue changes", async () => {
    await assert.rejects(svc.removeSession(key, "QQ", "s-day"), (e: unknown) => e instanceof svc.ServiceError && e.code === "forbidden");
    const before = await listed();
    await svc.removeSession(human, "QQ", "s-day");
    const after = await listed();
    assert.ok(!after.sessions.some((s) => s.id === "s-day"), "gone from the list");
    for (const s of after.sessions) assert.equal(s.pending, before.sessions.find((x) => x.id === s.id)!.pending, `${s.id} unchanged`);
    assert.ok((await row("s-day")).removedAt, "soft delete: the row is kept");
    await assert.rejects(svc.removeSession(human, "QQ", "s-day"), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found", "already removed");
    await assert.rejects(svc.removeSession(human, "QQ", "no-such-session"), (e: unknown) => e instanceof svc.ServiceError && e.code === "not_found");
  });

  test("mark all seen leaves a removed session's cursor alone, so replay still works", async () => {
    const before = (await row("s-day")).lastSeq;
    await svc.markAllSeen(human, { keyId: key.id, projectRef: "QQ" });
    assert.equal((await row("s-day")).lastSeq, before);
  });

  test("sessions idle over a week are deleted, 6.9 days is kept; removed ones are purged after 30 days, not before", async () => {
    await insert("s-6d", { lastSeenAgo: 6.9 * D });
    await insert("s-8d", { lastSeenAgo: 7 * D + H });
    await insert("s-rm-29d", { lastSeenAgo: 40 * D, removedAgo: 29 * D });
    await insert("s-rm-31d", { lastSeenAgo: 40 * D, removedAgo: 31 * D });
    await listed(); // reads prune
    const left = (await (await getDb()).select({ id: schema.workSessions.id }).from(schema.workSessions)).map((s) => s.id);
    assert.ok(left.includes("s-6d"), "6.9 days idle is kept");
    assert.ok(!left.includes("s-8d"), "over a week idle is deleted");
    assert.ok(left.includes("s-rm-29d"), "removed 29 days ago is still remembered");
    assert.ok(!left.includes("s-rm-31d"), "removed 31 days ago is purged");
    assert.ok(!(await listed()).sessions.some((s) => s.id === "s-6d" && s.bucket !== "d7"), "and the kept one sits in 1–7 days");
  });

  test("a removed session that reconnects lands at the top of the queue and is told what it missed", async () => {
    await changes(key, "s-rm"); // registers with a cursor
    const seen = (await changes(key, "s-rm")).latestSeq;
    await as(key, "ack_changes", { session: "s-rm", seq: seen });
    await svc.removeSession(human, "QQ", "s-rm");
    await svc.addComment(human, ticketRef, "while you were gone 1");
    await svc.addComment(human, ticketRef, "while you were gone 2");

    const first = (await changes(key, "s-rm")) as Resumable;
    assert.equal(first.total, 0, "default: top of the queue, nothing replayed");
    assert.equal(first.session_removed?.missedChanges, 2);
    assert.match(first.session_removed!.next, /resume_session/);
    assert.equal((await row("s-rm")).removedAt, null, "it is back in the list");
    assert.ok((await listed()).sessions.some((s) => s.id === "s-rm"));

    assert.equal(((await changes(key, "s-rm")) as Resumable).session_removed?.missedChanges, 2, "still reported until it chooses");
    const brief = await runTool({ ...key }, "get_briefing", { project: "QQ", session: "s-rm" });
    assert.equal((brief as { session_removed?: unknown }).session_removed !== undefined, true, "the briefing reports it too");
  });

  test("replay delivers exactly the missed changes; the notice is gone once it has chosen", async () => {
    await as(key, "resume_session", { session: "s-rm", mode: "replay" });
    const replayed = (await changes(key, "s-rm")) as Resumable;
    assert.deepEqual(replayed.changes.map((c) => c.summary).filter((x) => x.includes("comment")).length, 2);
    assert.equal(replayed.total, 2, "exactly what it missed, nothing more");
    assert.equal(replayed.session_removed, undefined);
    await assert.rejects(as(key, "resume_session", { session: "s-rm", mode: "skip" }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid", "nothing left to resume");
  });

  test("skip keeps it at the top of the queue and delivers nothing", async () => {
    await changes(key, "s-skip");
    await as(key, "ack_changes", { session: "s-skip", seq: (await changes(key, "s-skip")).latestSeq });
    await svc.removeSession(human, "QQ", "s-skip");
    await svc.addComment(human, ticketRef, "missed on purpose");
    assert.equal(((await changes(key, "s-skip")) as Resumable).session_removed?.missedChanges, 1);
    await as(key, "resume_session", { session: "s-skip", mode: "skip" });
    const after = (await changes(key, "s-skip")) as Resumable;
    assert.equal(after.total, 0);
    assert.equal(after.session_removed, undefined);
  });

  test("a session that was never removed has nothing to resume", async () => {
    await changes(key, "s-never");
    await assert.rejects(as(key, "resume_session", { session: "s-never", mode: "replay" }), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid");
    assert.equal(((await changes(key, "s-never")) as Resumable).session_removed, undefined);
  });
});
