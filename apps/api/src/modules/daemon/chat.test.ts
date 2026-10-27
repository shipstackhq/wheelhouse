/**
 * Chat with the codebase (docs/chat.md), the server's side against a real database: the person's endpoints' service, the signed
 * messages to the device, the events and finish the device reports, ownership, and the sweep. In-memory PGlite, or TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { createTeam } from "../teams/teams.legacy";
import { bus } from "../../platform/events/event-bus";
import { testApp } from "../../test/app";
import { ChatService } from "./chat.service";
import { DeviceAuthService } from "./device-auth.service";
import { DeviceChatService } from "./device-chat.service";
import { DeviceJobsService } from "./device-jobs.service";
import { DevicesService } from "./devices.service";
import { CHAT_PENDING_MS, CHAT_QUIET_MS, type Device } from "./device-common";
import { KeysService } from "../auth/keys/keys.service";
import { TeamAccessService } from "../teams/index";
import { ToolsService } from "../../lib/tools";
import { runMcp } from "../../lib/mcp";
import { publicKeyFromRaw, rawPublicKey, verifyValue } from "./daemon-crypto";

const app = await testApp();
const chat = app.get(ChatService);
const machine = app.get(DeviceChatService);
const auth = app.get(DeviceAuthService);
const jobs = app.get(DeviceJobsService);
const devices = app.get(DevicesService);
const keys = app.get(KeysService);
const access = app.get(TeamAccessService);
const tools = app.get(ToolsService);

const RUN = Math.random().toString(16).slice(2, 8);
let owner: Actor;
let teammate: Actor;
let stranger: Actor;
let repoId: string;

async function person(workspaceId: string, name: string): Promise<Actor> {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}-chat-${RUN}@example.com`, name, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role: name === "owner" ? "owner" : "member" });
  return { kind: "human", id: u.id, name, workspaceId };
}

before(async () => {
  const db = await getDb();
  const [ws] = await db.insert(schema.workspaces).values({ name: "Chat workspace" }).returning();
  const [other] = await db.insert(schema.workspaces).values({ name: "Other chat workspace" }).returning();
  owner = await person(ws.id, "owner");
  teammate = await person(ws.id, "teammate");
  stranger = await person(other.id, "stranger");
  const team = await createTeam(owner, { name: "Chat", key: "CH" });
  await db.insert(schema.teamMembers).values({ teamId: team.id, userId: teammate.id, workspaceId: ws.id, role: "editor" });
  const [repo] = await db
    .insert(schema.repositories)
    .values({ teamId: team.id, workspaceId: ws.id, displayName: "app", role: "app", provider: "github", slug: "chat1", githubRepoId: "5678", githubFullName: "acme/chat-app", defaultBranch: "main" })
    .returning();
  repoId = repo.id;
});

let n = 0;
/** A paired machine for `who`, online with the models it offers, and the server key it would pin. */
async function paired(who: Actor = owner) {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const start = await auth.startPairing({ publicKey: rawPublicKey(publicKey), name: "Laptop", os: "darwin" }, { ip: `10.1.0.${++n}`, origin: "https://wh.example" });
  const { device } = await devices.approvePairing(who, start.userCode);
  const poll = await auth.pollPairing({ deviceCode: start.deviceCode });
  assert.equal(poll.status, "approved");
  const row = (await (await getDb()).select().from(schema.devices).where(eq(schema.devices.id, device.id)))[0] as Device;
  await jobs.hello(row, { version: "0.1.0", capabilities: { claude: { installed: true, signedIn: true, models: ["opus", "sonnet"] } }, jobs: [] });
  return { device: row, serverKey: poll.status === "approved" ? poll.serverPublicKey : "" };
}

const code = (c: string) => (e: unknown) => e instanceof ServiceError && e.code === c;
const ev = (seq: number, type: string, data: Record<string, unknown> = {}) => ({ seq, at: new Date().toISOString(), type, data });
const input = (deviceId: string, extra: Record<string, unknown> = {}) => ({ teamKey: "CH", repositoryId: repoId, deviceId, model: "opus", message: "Where is login handled?", ...extra });
const answerOf = (r: { messages: { id: string; role: string }[] }) => r.messages.find((m) => m.role === "assistant")!;
const messagesTo = async (deviceId: string) => (await (await getDb()).select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, deviceId))).filter((m) => m.type.startsWith("chat."));

describe("starting a chat", () => {
  test("creates the thread, the question and an empty pending answer, and signs a chat.message for the device", async () => {
    const { device, serverKey } = await paired();
    const opts = await chat.options(owner, "CH");
    assert.deepEqual(opts.repositories.map((r) => r.id), [repoId]);
    assert.ok(opts.devices.some((d) => d.id === device.id && d.status === "online" && d.models.includes("opus")));

    const r = await chat.create(owner, input(device.id, { message: "  Where is login   handled?  " }));
    assert.equal(r.chat.title, "Where is login handled?");
    assert.equal(r.chat.running, true);
    assert.deepEqual([r.chat.teamKey, r.chat.repositoryName, r.chat.deviceName, r.chat.deviceStatus, r.chat.model], ["CH", "app", "Laptop", "online", "opus"]);
    assert.deepEqual(r.messages.map((m) => [m.seq, m.role, m.state]), [[1, "user", "done"], [2, "assistant", "pending"]]);
    assert.equal(r.messages[1].content, "");
    assert.equal(r.messages[1].costUsd, null);

    const [m] = await messagesTo(device.id);
    assert.equal(m.type, "chat.message");
    const body = m.message as { messageId: string; threadId: string; sessionId: string | null; prompt: string; model: string; repository: { cloneUrl: string; fullName: string }; expiresAt: string; deviceId: string };
    assert.equal(body.messageId, answerOf(r).id, "it names the answer being filled");
    assert.equal(body.threadId, r.chat.id);
    assert.equal(body.sessionId, null);
    assert.equal(body.prompt, "Where is login   handled?");
    assert.equal(body.repository.cloneUrl, "https://github.com/acme/chat-app.git");
    assert.ok(new Date(body.expiresAt).getTime() > Date.now());
    assert.equal(body.deviceId, device.id);
    assert.ok(verifyValue(publicKeyFromRaw(serverKey)!, m.message, m.signature), "the signature verifies against the key the device pinned");
  });

  test("a device that is not yours, offline, a model it does not offer, another team's repository and a bad message are refused", async () => {
    const mine = await paired();
    const theirs = await paired(teammate);
    await assert.rejects(chat.create(owner, input(theirs.device.id)), code("invalid"));
    await assert.rejects(chat.create(owner, input(mine.device.id, { model: "gpt" })), code("invalid"));
    await assert.rejects(chat.create(owner, input(mine.device.id, { repositoryId: crypto.randomUUID() })), code("invalid"));
    await assert.rejects(chat.create(owner, input(mine.device.id, { message: "   " })), code("invalid"));
    await assert.rejects(chat.create(owner, input(mine.device.id, { message: "x".repeat(8001) })), code("invalid"));
    await assert.rejects(chat.create(stranger, input(mine.device.id)), (e) => e instanceof ServiceError, "another workspace");
    await (await getDb()).update(schema.devices).set({ lastSeenAt: new Date(Date.now() - 3600e3) }).where(eq(schema.devices.id, mine.device.id));
    await assert.rejects(chat.create(owner, input(mine.device.id)), code("conflict"));
    assert.equal((await messagesTo(mine.device.id)).length, 0, "nothing was sent");
    assert.equal((await chat.list(owner)).chats.some((c) => c.deviceId === mine.device.id), false, "and no thread was left behind");
  });
});

describe("a conversation", () => {
  test("a second message is a 409 while the first answer runs; after it finishes the thread resumes the Claude session", async () => {
    const { device } = await paired();
    const first = await chat.create(owner, input(device.id));
    await assert.rejects(chat.send(owner, first.chat.id, { message: "and then?" }), code("conflict"));

    await machine.recordChatEvents(device, answerOf(first).id, { events: [ev(0, "delta", { text: "In " }), ev(1, "delta", { text: "auth.ts" })] });
    await machine.finishChat(device, answerOf(first).id, { state: "done", sessionId: "sess-1", costUsd: 0.0123 });

    const next = await chat.send(owner, first.chat.id, { message: "and then?" });
    assert.deepEqual(next.messages.map((m) => [m.seq, m.role, m.state]), [[3, "user", "done"], [4, "assistant", "pending"]]);
    const sent = (await messagesTo(device.id)).map((m) => m.message as { sessionId: string | null; prompt: string });
    assert.deepEqual(sent.map((m) => [m.prompt, m.sessionId]), [["Where is login handled?", null], ["and then?", "sess-1"]]);

    const view = await chat.get(owner, first.chat.id);
    assert.equal(view.messages.length, 4);
    assert.equal(view.messages[1].content, "In auth.ts");
    assert.equal(view.messages[1].costUsd, 0.0123);
    assert.equal((await chat.list(owner)).chats[0].id, first.chat.id, "newest activity first");
  });

  test("a follow-up can switch the model: the session carries over and the thread keeps the new one; one the device lacks is refused", async () => {
    const { device } = await paired();
    const first = await chat.create(owner, input(device.id));
    await machine.finishChat(device, answerOf(first).id, { state: "done", sessionId: "sess-m", text: "Here." });
    await assert.rejects(chat.send(owner, first.chat.id, { message: "more", model: "gpt-9" }), code("invalid"));

    await chat.send(owner, first.chat.id, { message: "more", model: "sonnet" });
    const sent = (await messagesTo(device.id)).map((m) => m.message as { model: string; sessionId: string | null });
    assert.deepEqual(sent.map((m) => [m.model, m.sessionId]), [[first.chat.model, null], ["sonnet", "sess-m"]]);
    assert.equal((await chat.get(owner, first.chat.id)).chat.model, "sonnet");
  });
});

describe("events and finish from the device", () => {
  test("deltas append, tool calls fill the activity (the latest 30), and the first event moves pending to streaming", async () => {
    const { device } = await paired();
    const r = await chat.create(owner, input(device.id));
    const id = answerOf(r).id;
    const seen: string[] = [];
    const off = bus.subscribe({ user: owner.id }, (e) => seen.push(`${e.type}:${e.entity}:${e.entityId}`));
    try {
      assert.deepEqual(await machine.recordChatEvents(device, id, { events: [ev(0, "phase", { phase: "starting" })] }), { stored: 1 });
      assert.equal((await chat.get(owner, r.chat.id)).messages[1].state, "streaming");
      assert.deepEqual(seen, [`chat.updated:chat:${r.chat.id}`], "the owner is told at once");

      const tools = Array.from({ length: 35 }, (_, i) => ev(10 + i, "tool", { name: "Read", summary: `file${i}.ts` }));
      await machine.recordChatEvents(device, id, { events: [ev(1, "delta", { text: "Hello " }), ev(2, "delta", { text: "world" }), ...tools] });
      const m = (await chat.get(owner, r.chat.id)).messages[1];
      assert.equal(m.content, "Hello world");
      assert.equal(m.activity.length, 30);
      assert.equal(m.activity[29].summary, "file34.ts");
      assert.equal(m.activity[0].summary, "file5.ts");

      // Deltas in a quick run are throttled to one signal per 300 ms.
      seen.length = 0;
      await machine.recordChatEvents(device, id, { events: [ev(100, "delta", { text: "a" })] });
      await machine.recordChatEvents(device, id, { events: [ev(101, "delta", { text: "b" })] });
      assert.ok(seen.length <= 1, `throttled, got ${seen.length}`);
    } finally {
      off();
    }
  });

  test("a batch sent again, and events at or below the last applied number, change nothing", async () => {
    const { device } = await paired();
    const r = await chat.create(owner, input(device.id));
    const id = answerOf(r).id;
    const batch = { events: [ev(0, "delta", { text: "one " }), ev(1, "delta", { text: "two" })] };
    assert.deepEqual(await machine.recordChatEvents(device, id, batch), { stored: 2 });
    assert.deepEqual(await machine.recordChatEvents(device, id, batch), { stored: 0 });
    assert.deepEqual(await machine.recordChatEvents(device, id, { events: [ev(1, "delta", { text: "two" }), ev(2, "delta", { text: "!" })] }), { stored: 1 });
    assert.equal((await chat.get(owner, r.chat.id)).messages[1].content, "one two!");
  });

  test("finish sets the final state; text fills an empty answer only; failed and canceled keep what streamed; the session id is kept", async () => {
    const { device } = await paired();
    const a = await chat.create(owner, input(device.id));
    await machine.finishChat(device, answerOf(a).id, { state: "done", text: "The whole answer", sessionId: "s-a" });
    const fa = (await chat.get(owner, a.chat.id)).messages[1];
    assert.deepEqual([fa.state, fa.content, fa.error], ["done", "The whole answer", null]);

    const b = await chat.create(owner, input(device.id));
    await machine.recordChatEvents(device, answerOf(b).id, { events: [ev(0, "delta", { text: "partial" })] });
    await machine.finishChat(device, answerOf(b).id, { state: "failed", text: "ignored", error: "claude crashed" });
    const fb = (await chat.get(owner, b.chat.id)).messages[1];
    assert.deepEqual([fb.state, fb.content, fb.error], ["failed", "partial", "claude crashed"]);

    const c = await chat.create(owner, input(device.id));
    await machine.finishChat(device, answerOf(c).id, { state: "canceled" });
    assert.equal((await chat.get(owner, c.chat.id)).messages[1].state, "canceled");
    assert.equal((await chat.get(owner, c.chat.id)).chat.running, false);

    const db = await getDb();
    assert.equal((await db.select().from(schema.chatThreads).where(eq(schema.chatThreads.id, a.chat.id)))[0].sessionId, "s-a");
    await assert.rejects(machine.finishChat(device, answerOf(c).id, { state: "bogus" }), code("invalid"));
  });

  test("a final message answers 409 to events and to a second finish", async () => {
    const { device } = await paired();
    const r = await chat.create(owner, input(device.id));
    const id = answerOf(r).id;
    await machine.finishChat(device, id, { state: "done", text: "x" });
    await assert.rejects(machine.recordChatEvents(device, id, { events: [ev(0, "delta", { text: "late" })] }), code("conflict"));
    await assert.rejects(machine.finishChat(device, id, { state: "failed" }), code("conflict"));
    assert.equal((await chat.get(owner, r.chat.id)).messages[1].content, "x");
  });
});

describe("cancel and delete", () => {
  test("cancel signs a chat.cancel for the running answer, which ends canceled when the device reports", async () => {
    const { device, serverKey } = await paired();
    const r = await chat.create(owner, input(device.id));
    const view = await chat.cancel(owner, r.chat.id);
    assert.equal(view.chat.running, true, "still running until the device says so");
    const cancel = (await messagesTo(device.id)).find((m) => m.type === "chat.cancel")!;
    assert.equal((cancel.message as { messageId: string }).messageId, answerOf(r).id);
    assert.ok(verifyValue(publicKeyFromRaw(serverKey)!, cancel.message, cancel.signature));
    await machine.finishChat(device, answerOf(r).id, { state: "canceled" });
    assert.equal((await chat.cancel(owner, r.chat.id)).chat.running, false);
    assert.equal((await messagesTo(device.id)).filter((m) => m.type === "chat.cancel").length, 1, "nothing running, nothing sent");
  });

  test("cancel ends the answer at once when the device is gone", async () => {
    const { device } = await paired();
    const r = await chat.create(owner, input(device.id));
    await (await getDb()).update(schema.devices).set({ lastSeenAt: new Date(Date.now() - 3600e3) }).where(eq(schema.devices.id, device.id));
    assert.equal((await chat.cancel(owner, r.chat.id)).chat.running, false);
    assert.equal((await chat.get(owner, r.chat.id)).messages[1].state, "canceled");
  });

  test("delete stops a running answer first, then removes the thread and its messages", async () => {
    const { device } = await paired();
    const r = await chat.create(owner, input(device.id));
    await chat.remove(owner, r.chat.id);
    assert.ok((await messagesTo(device.id)).some((m) => m.type === "chat.cancel"));
    await assert.rejects(chat.get(owner, r.chat.id), code("not_found"));
    const db = await getDb();
    assert.equal((await db.select().from(schema.chatMessages).where(eq(schema.chatMessages.threadId, r.chat.id))).length, 0);
  });
});

describe("whose chat it is", () => {
  test("another person, even a teammate, and another workspace cannot read, send, cancel or delete it", async () => {
    const { device } = await paired();
    const r = await chat.create(owner, input(device.id));
    for (const who of [teammate, stranger]) {
      assert.deepEqual((await chat.list(who)).chats.filter((c) => c.id === r.chat.id), []);
      await assert.rejects(chat.get(who, r.chat.id), code("not_found"));
      await assert.rejects(chat.send(who, r.chat.id, { message: "hi" }), code("not_found"));
      await assert.rejects(chat.cancel(who, r.chat.id), code("not_found"));
      await assert.rejects(chat.remove(who, r.chat.id), code("not_found"));
    }
    await assert.rejects(chat.get(owner, "not-a-uuid"), code("not_found"));
    await assert.rejects(chat.list({ kind: "agent", id: "a", name: "bot", workspaceId: owner.workspaceId } as Actor), code("forbidden"));
    assert.equal((await chat.get(owner, r.chat.id)).chat.id, r.chat.id, "untouched");
  });

  test("another device cannot report on the message", async () => {
    const mine = await paired();
    const other = await paired();
    const r = await chat.create(owner, input(mine.device.id));
    const id = answerOf(r).id;
    await assert.rejects(machine.recordChatEvents(other.device, id, { events: [ev(0, "delta", { text: "x" })] }), code("not_found"));
    await assert.rejects(machine.finishChat(other.device, id, { state: "done" }), code("not_found"));
    await assert.rejects(machine.finishChat(mine.device, crypto.randomUUID(), { state: "done" }), code("not_found"));
    await assert.rejects(machine.finishChat(mine.device, "nope", { state: "done" }), code("not_found"));
    assert.equal((await chat.get(owner, r.chat.id)).messages[1].state, "pending");
  });

  test("a message row cannot name a team's workspace other than its own", async () => {
    const { device } = await paired();
    const r = await chat.create(owner, input(device.id));
    const db = await getDb();
    await assert.rejects(db.update(schema.chatMessages).set({ workspaceId: stranger.workspaceId }).where(eq(schema.chatMessages.threadId, r.chat.id)));
  });
});

describe("the sweep", () => {
  test("a pending answer nobody started fails after 60 s, a streaming one that went quiet after 3 minutes; a live one is left alone", async () => {
    // The sweep is global: settle what the other tests left running so the counts below are this test's own.
    const db = await getDb();
    await db.update(schema.chatMessages).set({ state: "canceled" }).where(inArray(schema.chatMessages.state, ["pending", "streaming"]));
    const { device } = await paired();
    const pending = await chat.create(owner, input(device.id));
    const quiet = await chat.create(owner, input(device.id));
    await machine.recordChatEvents(device, answerOf(quiet).id, { events: [ev(0, "delta", { text: "so far" })] });
    const live = await chat.create(owner, input(device.id));
    await machine.recordChatEvents(device, answerOf(live).id, { events: [ev(0, "delta", { text: "alive" })] });

    const t0 = Date.now();
    assert.deepEqual(await machine.sweep(new Date(t0 + 1000)), { failed: 0 });
    const seen: string[] = [];
    const off = bus.subscribe({ user: owner.id }, (e) => seen.push(e.entityId!));
    try {
      assert.deepEqual(await machine.sweep(new Date(t0 + CHAT_PENDING_MS + 5000)), { failed: 1 });
      const p = (await chat.get(owner, pending.chat.id)).messages[1];
      assert.deepEqual([p.state, p.error], ["failed", "Your device did not answer"]);
      assert.deepEqual(seen, [pending.chat.id]);
      assert.equal((await chat.get(owner, quiet.chat.id)).messages[1].state, "streaming");

      await machine.recordChatEvents(device, answerOf(live).id, { events: [ev(1, "delta", { text: "!" })] });
      // Only the quiet one is old enough: move its clock back instead of waiting.
      await (await getDb()).update(schema.chatMessages).set({ updatedAt: new Date(t0 - CHAT_QUIET_MS - 5000) }).where(eq(schema.chatMessages.id, answerOf(quiet).id));
      assert.deepEqual(await machine.sweep(new Date(t0 + 1000)), { failed: 1 });
    } finally {
      off();
    }
    const q = (await chat.get(owner, quiet.chat.id)).messages[1];
    assert.deepEqual([q.state, q.content, q.error], ["failed", "so far", "Your device went quiet"]);
    assert.equal((await chat.get(owner, live.chat.id)).messages[1].state, "streaming");
    // A failed answer frees the thread for the next question.
    assert.equal((await chat.send(owner, pending.chat.id, { message: "try again" })).messages.length, 2);
    await assert.rejects(machine.recordChatEvents(device, answerOf(pending).id, { events: [ev(5, "delta", { text: "late" })] }), code("conflict"));
  });
});

describe("Wheelhouse data in a chat (the answer's own key)", () => {
  const tokenOf = async (deviceId: string) => ((await messagesTo(deviceId)).at(-1)!.message as { mcp: { token: string } }).mcp.token;
  const names = async (token: string) => {
    const r = (await runMcp(tools, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), () => keys.actorForKey(token, "1.1.1.1"))).body as { result: { tools: { name: string }[] } };
    return r.result.tools.map((t) => t.name);
  };

  test("a message carries a token that lists only read tools and reaches only the thread's team", async () => {
    const { device } = await paired();
    await chat.create(owner, input(device.id));
    const token = await tokenOf(device.id);
    const list = await names(token);
    assert.ok(list.includes("list_issues") && list.includes("create_issue") && !list.includes("plan"));
    const actor = await keys.actorForKey(token, "1.1.1.1");
    assert.deepEqual(actor.scopes, ["read", "board:write", "map:write", "docs:write"]);
    assert.equal(((await messagesTo(device.id)).at(-1)!.message as { mcp: { write: boolean } }).mcp.write, true);
    await access.require(actor, "CH", "read");
    await createTeam(owner, { name: "Other", key: "OT" });
    await assert.rejects(access.require(actor, "OT", "read"));
    const row = (await (await getDb()).select().from(schema.apiKeys).where(eq(schema.apiKeys.id, actor.id)))[0];
    assert.equal(row.name, `${owner.name} (chat)`);
    assert.notEqual(row.keyHash, token, "only the hash is stored");
  });

  test("CHAT_SCOPES=read makes the key read-only; planning is never granted; unknown names are ignored", async () => {
    const { device } = await paired();
    const prev = process.env.CHAT_SCOPES;
    try {
      process.env.CHAT_SCOPES = "read";
      await chat.create(owner, input(device.id));
      const ro = (await messagesTo(device.id)).at(-1)!.message as { mcp: { token: string; write: boolean } };
      assert.equal(ro.mcp.write, false);
      assert.deepEqual((await keys.actorForKey(ro.mcp.token, "1.1.1.1")).scopes, ["read"]);
      assert.ok(!(await names(ro.mcp.token)).includes("create_issue"));

      process.env.CHAT_SCOPES = "board:write, planning:write, nonsense";
      await chat.create(owner, input(device.id));
      assert.deepEqual((await keys.actorForKey(await tokenOf(device.id), "1.1.1.1")).scopes, ["read", "board:write"]);
    } finally {
      if (prev === undefined) delete process.env.CHAT_SCOPES;
      else process.env.CHAT_SCOPES = prev;
    }
  });

  test("a chat key creates an issue that reads as the person via chat", async () => {
    const { device } = await paired();
    await chat.create(owner, input(device.id));
    const actor = await keys.actorForKey(await tokenOf(device.id), "1.1.1.1");
    const call = (id: number, name: string, args: object) => runMcp(tools, JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), async () => actor);
    const made = JSON.stringify((await call(1, "create_issue", { team: "CH", title: "From chat" })).body);
    const ref = /CH-\d+/.exec(made)![0];
    await call(2, "comment", { team: "CH", ref, body: "hello" });
    assert.equal(actor.name, `${owner.name} (chat)`);
    const rows = await (await getDb()).select().from(schema.comments);
    assert.ok(rows.some((c) => c.authorName === `${owner.name} (chat)`));
    const issues = await (await getDb()).select().from(schema.issues).where(eq(schema.issues.title, "From chat"));
    assert.equal(issues.length, 1);
  });

  test("it is not on the keys page", async () => {
    const { device } = await paired();
    await chat.create(owner, input(device.id));
    const actor = await keys.actorForKey(await tokenOf(device.id), "1.1.1.1");
    assert.ok(!(await keys.listKeys({ actor: owner, workspace: { id: owner.workspaceId } } as never)).some((k) => k.id === actor.id));
  });

  test("it stops working when the answer ends, however it ends", async () => {
    const { device } = await paired();
    const done = await chat.create(owner, input(device.id));
    const t1 = await tokenOf(device.id);
    await machine.finishChat(device, answerOf(done).id, { state: "done" });
    await assert.rejects(keys.actorForKey(t1, "1.1.1.1"));

    const stopped = await chat.create(owner, input(device.id));
    const t2 = await tokenOf(device.id);
    await (await getDb()).update(schema.devices).set({ lastSeenAt: new Date(Date.now() - 3600e3) }).where(eq(schema.devices.id, device.id));
    await chat.cancel(owner, stopped.chat.id);
    await assert.rejects(keys.actorForKey(t2, "1.1.1.1"));
  });

  test("it stops working when it expires, and the sweep deletes it", async () => {
    const { device } = await paired();
    await chat.create(owner, input(device.id));
    const token = await tokenOf(device.id);
    const actor = await keys.actorForKey(token, "1.1.1.1");
    await (await getDb()).update(schema.apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiKeys.id, actor.id));
    await assert.rejects(keys.actorForKey(token, "1.1.1.1"));
    await machine.sweep();
    assert.equal((await (await getDb()).select().from(schema.apiKeys).where(eq(schema.apiKeys.id, actor.id))).length, 0);
  });
});
