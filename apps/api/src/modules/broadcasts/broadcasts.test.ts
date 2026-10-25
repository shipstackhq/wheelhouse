/**
 * A broadcast against a real database: who it reaches, that each person gets it once and sees it in every workspace of theirs, that a send
 * repeated or resumed after a failure creates only what is missing, and that the live signal reaches them. Runs on an in-memory PGlite
 * (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import crypto from "node:crypto";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { count, eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { ServiceError } from "../../common/service-error";
import type { Actor } from "../../common/actor";
import { testApp } from "../../test/app";
import { NotificationsService } from "../notifications/notifications.service";
import { openStream } from "../../platform/streams/stream-open";
import { workspaceScope } from "../../platform/streams/stream-scope";
import { BATCH, BroadcastsService } from "./broadcasts.service";

const app = await testApp();
const broadcasts = app.get(BroadcastsService);
const inbox = app.get(NotificationsService);
const RUN = crypto.randomBytes(3).toString("hex");
let wsA: string;
let wsB: string;
let ann: string;
let ben: string;
let cy: string;

const message = (key: string, extra: Record<string, unknown> = {}) => ({
  key: `${key}-${RUN}`,
  type: "marketing.launch",
  title: "Meet the new inbox",
  body: "**Now** with markdown",
  bodyFormat: "markdown" as const,
  audience: { kind: "everyone" as const },
  ...extra,
});

const people = async (n: number, prefix: string) =>
  (await (await getDb()).insert(schema.users).values(Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}-${RUN}@example.com`, name: prefix, passwordHash: "x" }))).returning()).map((u) => u.id);

const itemsOf = async (broadcastId: string) => (await (await getDb()).select({ n: count() }).from(schema.notifications).where(eq(schema.notifications.broadcastId, broadcastId)))[0].n;
const users = async () => (await (await getDb()).select({ n: count() }).from(schema.users))[0].n;

before(async () => {
  const db = await getDb();
  [wsA, wsB] = (await db.insert(schema.workspaces).values([{ name: `A ${RUN}` }, { name: `B ${RUN}` }]).returning()).map((w) => w.id);
  [ann, ben, cy] = await people(3, "p");
});

describe("send", () => {
  test("reaches everyone once, as instance-level system items carrying the message", async () => {
    const row = await broadcasts.send(message("launch"));
    assert.equal(row.status, "done");
    assert.equal(row.delivered, await users());
    assert.equal(await itemsOf(row.id), await users());
    assert.ok(row.completedAt);
    const db = await getDb();
    const [mine] = await db.select().from(schema.notifications).where(eq(schema.notifications.recipientUserId, ann));
    assert.equal(mine.workspaceId, null);
    assert.equal(mine.teamId, null);
    assert.equal(mine.source, "wheelhouse");
    assert.equal(mine.type, "marketing.launch");
    assert.equal(mine.title, "Meet the new inbox");
    assert.equal(mine.bodyFormat, "markdown");
    assert.equal(mine.actorKind, "system");
    assert.equal(mine.actorName, "Wheelhouse");
    assert.equal(mine.broadcastId, row.id);
  });

  test("a person sees it in every workspace of theirs, and reading or archiving it is once, not per workspace", async () => {
    const inA = { userId: ben, workspaceId: wsA };
    const inB = { userId: ben, workspaceId: wsB };
    const listed = async (w: typeof inA) => (await inbox.list(w)).items.filter((i) => i.type === "marketing.launch");
    assert.equal((await listed(inA)).length, 1);
    assert.equal((await listed(inB)).length, 1);
    assert.equal((await listed(inA))[0].id, (await listed(inB))[0].id, "one item, shown in both");
    const unread = async (w: typeof inA) => inbox.unreadCount(w);
    const before = await unread(inB);
    await inbox.markRead(inA, (await listed(inA))[0].id);
    assert.equal(await unread(inB), before - 1, "read in A is read in B");
  });

  test("another person cannot read, archive or delete it through their own inbox", async () => {
    const [bens] = (await inbox.list({ userId: ben, workspaceId: wsA })).items.filter((i) => i.type === "marketing.launch");
    const cys = { userId: cy, workspaceId: wsA };
    for (const act of [() => inbox.markRead(cys, bens.id), () => inbox.archive(cys, bens.id), () => inbox.delete(cys, bens.id)]) {
      await assert.rejects(act, (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    }
  });

  test("sending the same broadcast again changes nothing, even for someone who signed up since", async () => {
    const first = await broadcasts.send(message("repeat"));
    const [late] = await people(1, "late");
    const again = await broadcasts.send(message("repeat"));
    assert.equal(again.id, first.id);
    assert.equal(again.delivered, first.delivered);
    assert.equal(await itemsOf(first.id), first.delivered);
    const db = await getDb();
    assert.equal((await db.select().from(schema.notifications).where(eq(schema.notifications.recipientUserId, late))).filter((n) => n.broadcastId === first.id).length, 0, "a done broadcast is final");
  });

  test("the same key with different content is refused, not sent as the old message", async () => {
    await broadcasts.send(message("fixed"));
    await assert.rejects(broadcasts.send(message("fixed", { title: "A different title" })), (e: unknown) => e instanceof ServiceError && e.code === "conflict");
    await assert.rejects(broadcasts.send(message("fixed", { body: "changed" })), (e: unknown) => e instanceof ServiceError && e.code === "conflict");
  });

  test("a bad message or audience is invalid and creates nothing", async () => {
    const db = await getDb();
    const rows = async () => (await db.select({ n: count() }).from(schema.broadcasts))[0].n;
    const before = await rows();
    for (const bad of [message("bad1", { title: "" }), message("bad2", { audience: { kind: "nobody" } }), message("bad3", { type: "" }), { ...message("bad4"), bodyFormat: "html" }]) {
      await assert.rejects(broadcasts.send(bad as never), (e: unknown) => e instanceof ServiceError && e.code === "invalid");
    }
    assert.equal(await rows(), before);
  });
});

describe("a large audience and a failure halfway", () => {
  test("spans several batches, and a send that stops is finished by sending it again, with nobody told twice", async () => {
    await people(BATCH * 2 + 100, "many");
    const total = await users();
    assert.ok(total > BATCH * 2);

    // The second batch fails once: the first batch's items are already in.
    const original = inbox.notifyMany.bind(inbox);
    let calls = 0;
    inbox.notifyMany = async (inputs) => {
      if (++calls === 2) throw new Error("database went away");
      return original(inputs);
    };
    let stopped;
    try {
      await assert.rejects(broadcasts.send(message("resume")), /database went away/);
      [stopped] = await (await getDb()).select().from(schema.broadcasts).where(eq(schema.broadcasts.key, `resume-${RUN}`));
    } finally {
      inbox.notifyMany = original;
    }
    assert.equal(stopped.status, "failed");
    assert.match(stopped.error ?? "", /database went away/);
    assert.equal(await itemsOf(stopped.id), BATCH);
    assert.equal(stopped.delivered, BATCH);

    const done = await broadcasts.send(message("resume"));
    assert.equal(done.id, stopped.id);
    assert.equal(done.status, "done");
    assert.equal(done.error, null);
    assert.equal(await itemsOf(done.id), total, "everyone has it");
    assert.equal(done.delivered, total, "and each was counted once");
  });
});

describe("the live signal", () => {
  test("every open stream of a person, in any of their workspaces, hears it once, with no content", async () => {
    const dee = (await people(1, "dee"))[0];
    const actorIn = (workspaceId: string): Actor => ({ kind: "human", id: dee, name: "x", workspaceId });
    const open = async (workspaceId: string) => {
      const ac = new AbortController();
      const r = await openStream({ getActor: async () => actorIn(workspaceId), scopeFor: workspaceScope(), lastEventId: null, since: null, signal: ac.signal });
      assert.ok("body" in r, "the stream opens");
      return { ac, body: r.body };
    };
    const a = await open(wsA);
    const b = await open(wsB);
    await broadcasts.send(message("signal", { title: "secret launch title", body: "secret body" }));
    a.ac.abort();
    b.ac.abort();
    for (const text of [await drain(a.body), await drain(b.body)]) {
      assert.equal(text.split("inbox.changed").length - 1, 1);
      assert.equal(text.includes("secret"), false);
      assert.equal(text.includes(dee), false, "the stream never names the recipient");
    }
  });
});

async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value);
  }
}
