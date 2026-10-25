/**
 * The inbox against a real database: dedupe, the recipient scope of every read and change, the unread filter and count, and the
 * cursor. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
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
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { ServiceError } from "../../common/service-error";
import { testApp } from "../../test/app";
import { NotificationsService } from "./notifications.service";
import type { Recipient } from "./notifications.repository";
import { bus, type StreamEvent } from "../../platform/events/event-bus";
import { INBOX_CHANGED } from "./notifications.signal";
import { openStream } from "../../platform/streams/stream-open";
import { workspaceScope } from "../../platform/streams/stream-scope";
import type { Actor } from "../../common/actor";
await testApp();

const RUN = crypto.randomBytes(3).toString("hex");
const service = (await testApp()).get(NotificationsService);
let workspaceId: string;
let alice: string;
let bob: string;
let carol: string;

before(async () => {
  const db = await getDb();
  const [ws] = await db.insert(schema.workspaces).values({ name: `inbox ${RUN}` }).returning();
  workspaceId = ws.id;
  const person = async (name: string) => {
    const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}@example.com`, name, passwordHash: "x" }).returning();
    return u.id;
  };
  alice = await person("alice");
  bob = await person("bob");
  carol = await person("carol");
});

/** The recipient of a call: a person in this test's workspace. */
const who = (userId: string): Recipient => ({ userId, workspaceId });

const item = (recipientUserId: string, extra: Record<string, unknown> = {}) => ({
  workspaceId,
  recipientUserId,
  source: "test",
  type: "issue.assigned",
  title: "Assigned to you",
  ...extra,
});

/** Rejects with the code of the ServiceError, or fails the test if it resolves. */
async function refusedWith(code: string, fn: () => Promise<unknown>) {
  await assert.rejects(fn, (e: unknown) => e instanceof ServiceError && e.code === code);
}

describe("notify", () => {
  test("creates the item, and a repeat with the same dedupe key for the same recipient returns null", async () => {
    const first = await service.notify(item(alice, { dedupeKey: `dup-${RUN}`, body: "hello", data: { n: 1 } }));
    assert.ok(first);
    assert.equal(first.body, "hello");
    assert.deepEqual(first.data, { n: 1 });
    assert.equal(first.readAt, null);
    assert.equal(await service.notify(item(alice, { dedupeKey: `dup-${RUN}` })), null);
  });

  test("the same dedupe key for another recipient is a new item; no key never dedupes", async () => {
    const key = `shared-${RUN}`;
    assert.ok(await service.notify(item(alice, { dedupeKey: key })));
    assert.ok(await service.notify(item(bob, { dedupeKey: key })));
    assert.ok(await service.notify(item(bob)));
    assert.ok(await service.notify(item(bob)));
  });

  test("an invalid input is refused as invalid", async () => {
    await refusedWith("invalid", () => service.notify(item(alice, { title: "" })));
    await refusedWith("invalid", () => service.notify(item("not-a-uuid")));
  });
});

describe("the inbox of one recipient", () => {
  before(async () => {
    for (let i = 0; i < 3; i++) await service.notify(item(carol, { title: `c${i}` }));
  });

  test("list returns only the recipient's items, newest first", async () => {
    const { items } = await service.list(who(carol), { limit: 100 });
    assert.equal(items.length, 3);
    assert.ok(items.every((i) => i.recipientUserId === carol));
    const times = items.map((i) => i.createdAt.getTime());
    assert.deepEqual([...times].sort((a, b) => b - a), times);
    const { items: aliceItems } = await service.list(who(alice), { limit: 100 });
    assert.ok(aliceItems.every((i) => i.recipientUserId === alice));
    assert.ok(!aliceItems.some((i) => i.recipientUserId === carol));
  });

  test("unreadOnly leaves out read items; unreadCount counts unread, unarchived items", async () => {
    const before = await service.unreadCount(who(carol));
    const { items } = await service.list(who(carol), { limit: 100 });
    await service.markRead(who(carol), items[0].id);
    assert.equal(await service.unreadCount(who(carol)), before - 1);
    const { items: unread } = await service.list(who(carol), { unreadOnly: "true", limit: 100 });
    assert.ok(!unread.some((i) => i.id === items[0].id));
    assert.equal(unread.length, before - 1);
  });

  test("markRead keeps the first read time, and only the owner can mark an item", async () => {
    const [mine] = (await service.list(who(carol), { limit: 1 })).items;
    const [other] = (await service.list(who(alice), { limit: 1 })).items;
    await refusedWith("not_found", () => service.markRead(who(bob), mine.id));
    await refusedWith("not_found", () => service.markRead(who(carol), other.id));
    await refusedWith("not_found", () => service.archive(who(bob), mine.id));
    const readAt = (await service.markRead(who(carol), mine.id)).readAt;
    assert.ok(readAt);
    assert.deepEqual((await service.markRead(who(carol), mine.id)).readAt, readAt);
  });

  test("markAllRead changes only the owner's unread items and returns how many", async () => {
    const aliceBefore = await service.unreadCount(who(alice));
    const unread = await service.unreadCount(who(carol));
    assert.equal(await service.markAllRead(who(carol)), unread);
    assert.equal(await service.unreadCount(who(carol)), 0);
    assert.equal(await service.unreadCount(who(alice)), aliceBefore);
  });

  test("archive takes an item out of the list and the count, for its owner only", async () => {
    const [mine] = (await service.list(who(alice), { limit: 1 })).items;
    const unread = await service.unreadCount(who(alice));
    await service.archive(who(alice), mine.id);
    const { items } = await service.list(who(alice), { limit: 100 });
    assert.ok(!items.some((i) => i.id === mine.id));
    if (!mine.readAt) assert.equal(await service.unreadCount(who(alice)), unread - 1);
    const [row] = await (await getDb()).select().from(schema.notifications).where(eq(schema.notifications.id, mine.id));
    assert.ok(row.archivedAt);
  });
});

describe("cursor pagination", () => {
  test("pages walk the whole inbox once, newest first, with no repeats or gaps", async () => {
    const dana = await (async () => {
      const db = await getDb();
      const [u] = await db.insert(schema.users).values({ email: `dana-${RUN}@example.com`, name: "dana", passwordHash: "x" }).returning();
      return u.id;
    })();
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await service.notify(item(dana, { title: `d${i}` })))!.id);

    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await service.list(who(dana), { limit: 2, cursor: cursor ?? undefined });
      assert.ok(page.items.length <= 2);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);

    const { items: whole } = await service.list(who(dana), { limit: 100 });
    assert.deepEqual(seen, whole.map((i) => i.id));
    assert.deepEqual([...seen].sort(), [...made].sort());
  });
});

/** A real team of the workspace: a notification's team is a foreign key, so a made-up id is refused by the database. */
const teamIn = async (ws: string) => {
  const [t] = await (await getDb()).insert(schema.teams).values({ workspaceId: ws, key: `N${crypto.randomBytes(2).toString("hex").toUpperCase()}`, name: "Notify" }).returning();
  return t.id;
};
const otherWorkspace = async () => {
  const [w] = await (await getDb()).insert(schema.workspaces).values({ name: `elsewhere ${crypto.randomBytes(3).toString("hex")}` }).returning();
  return w.id;
};

const newPerson = async (name: string) => {
  const [u] = await (await getDb()).insert(schema.users).values({ email: `${name}-${crypto.randomBytes(3).toString("hex")}@example.com`, name, passwordHash: "x" }).returning();
  return u.id;
};

describe("the recipient's workspace and team", () => {
  test("an item of another workspace is not the recipient's here: not listed, counted, or changed", async () => {
    const db = await getDb();
    const [other] = await db.insert(schema.workspaces).values({ name: `other ${RUN}` }).returning();
    const hal = await newPerson("hal");
    const mine = await service.notify(item(hal, { title: "in this workspace" }));
    const theirs = await service.notify({ ...item(hal, { title: "elsewhere" }), workspaceId: other.id });
    const elsewhere = { userId: hal, workspaceId: other.id };
    const { items } = await service.list(who(hal), { limit: 100 });
    assert.deepEqual(items.map((i) => i.id), [mine!.id]);
    assert.equal(await service.unreadCount(elsewhere), 1);
    assert.equal(await service.unreadCount(who(hal)), 1);
    await refusedWith("not_found", () => service.markRead(who(hal), theirs!.id));
    await refusedWith("not_found", () => service.archive(who(hal), theirs!.id));
    assert.equal(await service.markAllRead(who(hal)), 1);
    assert.equal(await service.unreadCount(elsewhere), 1, "read-all in this workspace leaves the other one alone");
  });

  test("teamId keeps one team's items, for the list and the unread count; a team of another workspace has none", async () => {
    const jo = await newPerson("jo");
    const t1 = await teamIn(workspaceId);
    const t2 = await teamIn(workspaceId);
    const elsewhere = await teamIn(await otherWorkspace());
    await service.notify(item(jo, { teamId: t1, title: "t1" }));
    await service.notify(item(jo, { teamId: t1, title: "t1 again" }));
    await service.notify(item(jo, { teamId: t2, title: "t2" }));
    await service.notify(item(jo, { title: "workspace-level" }));
    const { items } = await service.list(who(jo), { limit: 100, teamId: t1 });
    assert.equal(items.length, 2);
    assert.ok(items.every((i) => i.teamId === t1));
    assert.equal(await service.unreadCount(who(jo), { teamId: t1 }), 2);
    assert.equal(await service.unreadCount(who(jo)), 4);
    assert.equal((await service.list(who(jo), { limit: 100, teamId: elsewhere })).items.length, 0, "another workspace's team has none of this inbox");
  });

  test("a bad id is not_found, not a database error; bad query values are invalid", async () => {
    const kim = await newPerson("kim");
    await refusedWith("not_found", () => service.markRead(who(kim), "not-a-uuid"));
    await refusedWith("not_found", () => service.archive(who(kim), "12"));
    await refusedWith("invalid", () => service.list(who(kim), { limit: 0 }));
    await refusedWith("invalid", () => service.list(who(kim), { limit: 101 }));
    await refusedWith("invalid", () => service.list(who(kim), { teamId: "not-a-uuid" }));
    await refusedWith("invalid", () => service.list(who(kim), { unreadOnly: "maybe" as never }));
    await refusedWith("invalid", () => service.list(who(kim), { cursor: "nope" }));
    await refusedWith("invalid", () => service.unreadCount(who(kim), { teamId: "nope" }));
  });
});

const rowOf = async (id: string) => (await (await getDb()).select().from(schema.notifications).where(eq(schema.notifications.id, id)))[0];
const ids = async (userId: string, view: "inbox" | "archived" | "trash", extra: Record<string, unknown> = {}) =>
  (await service.list(who(userId), { view, limit: 100, ...extra })).items.map((i) => i.id);

describe("archive, trash and restore", () => {
  test("the three views split the items; the default is the inbox; a bad view is invalid", async () => {
    const u = await newPerson("vera");
    const a = (await service.notify(item(u, { title: "a" })))!.id;
    const b = (await service.notify(item(u, { title: "b" })))!.id;
    const c = (await service.notify(item(u, { title: "c" })))!.id;
    const d = (await service.notify(item(u, { title: "d" })))!.id;
    await service.archive(who(u), b);
    await service.delete(who(u), c);
    await service.archive(who(u), d);
    await service.delete(who(u), d);
    assert.deepEqual(await ids(u, "inbox"), [a]);
    assert.deepEqual((await service.list(who(u), { limit: 100 })).items.map((i) => i.id), [a]);
    assert.deepEqual(await ids(u, "archived"), [b]);
    assert.deepEqual((await ids(u, "trash")).sort(), [c, d].sort());
    await refusedWith("invalid", () => service.list(who(u), { view: "bin" as never }));
  });

  test("each view pages by its own keyset with no repeats or gaps; the trash orders by deleted_at", async () => {
    const u = await newPerson("walt");
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await service.notify(item(u, { title: `w${i}` })))!.id);
    for (const id of made) await service.archive(who(u), id);
    for (const view of ["inbox", "archived", "trash"] as const) {
      if (view === "trash") {
        // delete in an order unlike creation order: the trash lists latest deleted first
        for (const id of [made[2], made[0], made[4], made[1]]) await service.delete(who(u), id);
      }
      const seen: string[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await service.list(who(u), { view, limit: 2, cursor: cursor ?? undefined });
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor);
      const whole = await ids(u, view);
      assert.deepEqual(seen, whole, view);
      if (view === "inbox") assert.equal(seen.length, 0);
      if (view === "archived") assert.equal(seen.length, 5);
      if (view === "trash") assert.deepEqual(seen, [made[1], made[4], made[0], made[2]]);
    }
  });

  test("unarchive round trip; archive is idempotent", async () => {
    const u = await newPerson("xena");
    const id = (await service.notify(item(u)))!.id;
    const first = await service.archive(who(u), id);
    assert.deepEqual((await service.archive(who(u), id)).archivedAt, first.archivedAt);
    assert.deepEqual(await ids(u, "inbox"), []);
    assert.equal((await service.unarchive(who(u), id)).archivedAt, null);
    assert.deepEqual(await ids(u, "inbox"), [id]);
  });

  test("delete works from the inbox and from the archive, keeps the first delete time; archive/unarchive refuse a deleted item", async () => {
    const u = await newPerson("yuri");
    const fromInbox = (await service.notify(item(u)))!.id;
    const fromArchive = (await service.notify(item(u)))!.id;
    await service.archive(who(u), fromArchive);
    const d1 = await service.delete(who(u), fromInbox);
    assert.ok(d1.deletedAt);
    assert.deepEqual((await service.delete(who(u), fromInbox)).deletedAt, d1.deletedAt);
    assert.ok((await service.delete(who(u), fromArchive)).deletedAt);
    assert.deepEqual((await ids(u, "trash")).sort(), [fromInbox, fromArchive].sort());
    await refusedWith("not_found", () => service.archive(who(u), fromInbox));
    await refusedWith("not_found", () => service.unarchive(who(u), fromArchive));
    assert.equal((await rowOf(fromArchive)).archivedAt !== null, true);
  });

  test("restore returns an item to the inbox, or to the archive when it was archived; refused when not deleted", async () => {
    const u = await newPerson("zed");
    const live = (await service.notify(item(u)))!.id;
    const arch = (await service.notify(item(u)))!.id;
    await service.archive(who(u), arch);
    await refusedWith("not_found", () => service.restore(who(u), live));
    await service.delete(who(u), live);
    await service.delete(who(u), arch);
    const r1 = await service.restore(who(u), live);
    assert.equal(r1.deletedAt, null);
    await service.restore(who(u), arch);
    assert.deepEqual(await ids(u, "inbox"), [live]);
    assert.deepEqual(await ids(u, "archived"), [arch]);
    assert.deepEqual(await ids(u, "trash"), []);
    await refusedWith("not_found", () => service.restore(who(u), arch));
  });

  test("unread count and read-all only touch the inbox", async () => {
    const u = await newPerson("abe");
    const ids3 = [];
    for (let i = 0; i < 3; i++) ids3.push((await service.notify(item(u)))!.id);
    await service.archive(who(u), ids3[0]);
    await service.delete(who(u), ids3[1]);
    assert.equal(await service.unreadCount(who(u)), 1);
    assert.equal(await service.markAllRead(who(u)), 1);
    assert.equal((await rowOf(ids3[0])).readAt, null);
    assert.equal((await rowOf(ids3[1])).readAt, null);
  });

  test("another person's or workspace's item is not_found on every new action; a bad id too", async () => {
    const owner = await newPerson("bo");
    const stranger = await newPerson("cy");
    const id = (await service.notify(item(owner)))!.id;
    await service.delete(who(owner), id);
    const wrong: Recipient[] = [who(stranger), { userId: owner, workspaceId: await otherWorkspace() }];
    for (const w of wrong) {
      await refusedWith("not_found", () => service.unarchive(w, id));
      await refusedWith("not_found", () => service.delete(w, id));
      await refusedWith("not_found", () => service.restore(w, id));
    }
    for (const bad of ["not-a-uuid", "7"]) {
      await refusedWith("not_found", () => service.unarchive(who(owner), bad));
      await refusedWith("not_found", () => service.delete(who(owner), bad));
      await refusedWith("not_found", () => service.restore(who(owner), bad));
    }
    assert.ok((await rowOf(id)).deletedAt, "unchanged by the refused calls");
  });

  test("a deleted item still blocks the same dedupe key until it is purged", async () => {
    const u = await newPerson("dee");
    const key = `trash-${RUN}`;
    const id = (await service.notify(item(u, { dedupeKey: key })))!.id;
    await service.delete(who(u), id);
    assert.equal(await service.notify(item(u, { dedupeKey: key })), null, "a producer retry does not resurrect it");
    assert.deepEqual(await ids(u, "inbox"), []);
    const db = await getDb();
    await db.update(schema.notifications).set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(schema.notifications.id, id));
    assert.ok((await service.purge()) >= 1);
    assert.ok(await service.notify(item(u, { dedupeKey: key })), "after the purge the key is free");
  });
});

describe("purge", () => {
  test("removes only rows deleted more than 30 days before now: 29 days kept, 31 removed; archived and live rows stay", async () => {
    const u = await newPerson("eli");
    const mk = async (title: string) => (await service.notify(item(u, { title })))!.id;
    const d29 = await mk("d29");
    const d31 = await mk("d31");
    const archived = await mk("archived");
    const live = await mk("live");
    const db = await getDb();
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    await db.update(schema.notifications).set({ deletedAt: ago(29) }).where(eq(schema.notifications.id, d29));
    await db.update(schema.notifications).set({ deletedAt: ago(31) }).where(eq(schema.notifications.id, d31));
    await service.archive(who(u), archived);
    await db.update(schema.notifications).set({ archivedAt: ago(90) }).where(eq(schema.notifications.id, archived));
    const removed = await service.purge();
    assert.ok(removed >= 1);
    assert.equal(await rowOf(d31), undefined);
    assert.ok(await rowOf(d29));
    assert.ok(await rowOf(archived));
    assert.ok(await rowOf(live));
    // an injected "now" 2 days later makes the 29-day row 31 days old
    assert.ok((await service.purge(new Date(Date.now() + 2 * 86_400_000))) >= 1);
    assert.equal(await rowOf(d29), undefined);
    assert.ok(await rowOf(live), "live rows are never purged");
  });

  test("bodyFormat defaults to text, accepts markdown, rejects anything else, and reaches the item view", async () => {
    const { notificationView } = await import("./notifications.presenter");
    const u = await newPerson("gus");
    const plain = await service.notify(item(u, { dedupeKey: `bf-a-${RUN}` }));
    assert.equal(plain!.bodyFormat, "text");
    assert.equal(notificationView(plain!).bodyFormat, "text");
    const md = await service.notify(item(u, { dedupeKey: `bf-b-${RUN}`, body: "**hi**", bodyFormat: "markdown" }));
    assert.equal(notificationView(md!).bodyFormat, "markdown");
    await assert.rejects(service.notify(item(u, { dedupeKey: `bf-c-${RUN}`, bodyFormat: "html" as never })));
  });

  test("the item view carries archivedAt, deletedAt and purgeAt (deletedAt + 30 days) and still hides the private fields", async () => {
    const { notificationView } = await import("./notifications.presenter");
    const u = await newPerson("fay");
    const row = await service.notify(item(u, { dedupeKey: `v-${RUN}`, data: { s: 1 }, actorId: crypto.randomUUID() }));
    const live = notificationView(row!);
    assert.equal(live.deletedAt, null);
    assert.equal(live.purgeAt, null);
    assert.equal(live.archivedAt, null);
    const del = notificationView(await service.delete(who(u), row!.id));
    assert.equal(del.purgeAt!.getTime(), del.deletedAt!.getTime() + 30 * 86_400_000);
    for (const k of ["recipientUserId", "workspaceId", "dedupeKey", "data", "actorId"]) assert.equal(k in del, false, k);
  });
});

describe("the live inbox signal", () => {
  /** The inbox signals the bus carries for `userId` while `fn` runs. */
  async function signalsFor(userId: string, fn: () => Promise<unknown>) {
    const got: StreamEvent[] = [];
    const off = bus.subscribe({ user: userId }, (e) => {
      if (e.type === INBOX_CHANGED) got.push(e);
    });
    try {
      await fn();
    } finally {
      off();
    }
    return got;
  }

  test("notify signals the recipient once, not on a deduped repeat, and the signal carries no content", async () => {
    const lou = await newPerson("lou");
    const key = `signal-${RUN}`;
    const first = await signalsFor(lou, () => service.notify(item(lou, { dedupeKey: key, title: "secret title", body: "secret body", href: "/private/x" })));
    assert.equal(first.length, 1);
    assert.deepEqual(Object.keys(first[0]).sort(), ["recipientUserId", "teamId", "type", "workspaceId"]);
    assert.equal(JSON.stringify(first[0]).includes("secret"), false);
    assert.equal(first[0].type, "inbox.changed");
    const repeat = await signalsFor(lou, () => service.notify(item(lou, { dedupeKey: key })));
    assert.equal(repeat.length, 0, "a deduped notify changes nothing, so it signals nothing");
  });

  test("read, read-all and archive each signal the person who acted", async () => {
    const meg = await newPerson("meg");
    const a = await service.notify(item(meg, { title: "a" }));
    await service.notify(item(meg, { title: "b" }));
    assert.equal((await signalsFor(meg, () => service.markRead(who(meg), a!.id))).length, 1);
    assert.equal((await signalsFor(meg, () => service.markAllRead(who(meg)))).length, 1);
    assert.equal((await signalsFor(meg, () => service.archive(who(meg), a!.id))).length, 1);
  });

  test("unarchive, delete and restore each signal once, with no content; a refused one signals nothing", async () => {
    const ivy = await newPerson("ivy");
    const id = (await service.notify(item(ivy, { title: "secret title" })))!.id;
    await service.archive(who(ivy), id);
    for (const act of [() => service.unarchive(who(ivy), id), () => service.delete(who(ivy), id), () => service.restore(who(ivy), id)]) {
      const got = await signalsFor(ivy, act);
      assert.equal(got.length, 1);
      assert.deepEqual(Object.keys(got[0]).sort(), ["recipientUserId", "teamId", "type", "workspaceId"]);
      assert.equal(JSON.stringify(got[0]).includes("secret"), false);
    }
    const refused = await signalsFor(ivy, async () => {
      await service.restore(who(ivy), id).catch(() => undefined); // not deleted now
      await service.unarchive(who(await newPerson("nobody")), id).catch(() => undefined);
    });
    assert.equal(refused.length, 0);
  });

  test("a refused change signals nothing", async () => {
    const ned = await newPerson("ned");
    const mine = await service.notify(item(ned));
    const stranger = await newPerson("stranger");
    const got = await signalsFor(stranger, () => service.markRead(who(stranger), mine!.id).catch(() => undefined));
    assert.equal(got.length, 0);
  });

  test("an open workspace stream hears the signal for its own person only", async () => {
    const pat = await newPerson("pat");
    const quin = await newPerson("quin");
    const actorOf = (userId: string): Actor => ({ kind: "human", id: userId, name: "x", workspaceId });
    const open = async (userId: string) => {
      const ac = new AbortController();
      const r = await openStream({ getActor: async () => actorOf(userId), scopeFor: workspaceScope(), lastEventId: null, since: null, signal: ac.signal });
      assert.ok("body" in r, "the stream opens");
      return { ac, body: r.body };
    };
    const forPat = await open(pat);
    const forQuin = await open(quin);
    await service.notify(item(pat, { title: "for pat only" }));
    forPat.ac.abort();
    forQuin.ac.abort();
    const patText = await drain(forPat.body);
    const quinText = await drain(forQuin.body);
    assert.equal(patText.split("inbox.changed").length - 1, 1);
    assert.equal(quinText.includes("inbox.changed"), false, "another member's stream does not hear it");
    assert.equal(patText.includes(pat), false, "the stream never names the recipient");
    assert.equal(patText.includes("for pat only"), false, "nor the content");
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
