/**
 * The agent daemon's server side against a real database: pairing, the device's tokens, signed messages and its stream, and a job from
 * "Run on device" to finish. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
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
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import * as svc from "./service";
import * as d from "./daemon";
import { ASSERTION_AUDIENCE, canonicalJson, publicKeyFromRaw, rawPublicKey, resetSigningKeyCache, verifyAssertion, verifyValue } from "./daemon-crypto";

const RUN = Math.random().toString(16).slice(2, 8);
let owner: Actor;
let teammate: Actor;
let viewer: Actor;
let stranger: Actor;
let repoId: string;

async function person(workspaceId: string, name: string, role: "owner" | "member" | "viewer" = "member"): Promise<Actor> {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}@example.com`, name, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role });
  return { kind: "human", id: u.id, name, workspaceId };
}

before(async () => {
  const db = await getDb();
  const [ws] = await db.insert(schema.workspaces).values({ name: "Daemon workspace" }).returning();
  const [other] = await db.insert(schema.workspaces).values({ name: "Other workspace" }).returning();
  owner = await person(ws.id, "owner", "owner");
  teammate = await person(ws.id, "teammate");
  viewer = await person(ws.id, "viewer", "viewer");
  stranger = await person(other.id, "stranger", "owner");
  const team = await svc.createTeam(owner, { name: "Daemon", key: "DM" });
  for (const p of [teammate, viewer]) await db.insert(schema.teamMembers).values({ teamId: team.id, userId: p.id, workspaceId: ws.id, role: "editor" });
  const [repo] = await db
    .insert(schema.repositories)
    .values({ teamId: team.id, workspaceId: ws.id, displayName: "app", role: "app", provider: "github", slug: "1234", githubRepoId: "1234", githubFullName: "acme/app", defaultBranch: "main" })
    .returning();
  repoId = repo.id;
  // A local repository cannot be cloned, so it is never offered.
  await db.insert(schema.repositories).values({ teamId: team.id, workspaceId: ws.id, displayName: "local", role: "x", provider: "local", slug: "local" });
});

/** A machine: its key pair, as the daemon would make it. */
function machine() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicKey: rawPublicKey(publicKey) };
}

function assertion(deviceId: string, key: crypto.KeyObject, o: { aud?: string; iat?: number; exp?: number; jti?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({ sub: deviceId, aud: o.aud ?? ASSERTION_AUDIENCE, iat: o.iat ?? now, exp: o.exp ?? now + 120, jti: o.jti ?? crypto.randomUUID() })}`;
  return `${head}.${crypto.sign(null, Buffer.from(head), key).toString("base64url")}`;
}

const ctx = { ip: "127.0.0.1", origin: "https://wh.example" };

/** Pair a machine for `who`, and get it a token: what `wheelhouse-daemon pair` and its first connect do. */
async function paired(who: Actor = owner) {
  const m = machine();
  const start = await d.startPairing({ publicKey: m.publicKey, name: "Laptop", os: "darwin" }, ctx);
  const { device } = await d.approvePairing(who, start.userCode);
  const poll = await d.pollPairing({ deviceCode: start.deviceCode });
  assert.equal(poll.status, "approved");
  const { accessToken } = await d.exchangeAssertion({ assertion: assertion(device.id, m.privateKey) }, ctx);
  const row = await d.deviceForToken(`Bearer ${accessToken}`);
  return { ...m, device: row, accessToken, poll };
}

/** Bring a device online with the models it offers. */
async function online(device: d.Device, models = ["opus", "sonnet"]) {
  await d.deviceHello(device, { version: "0.1.0", capabilities: { claude: { installed: true, signedIn: true, models }, repositories: [] }, jobs: [] });
  const db = await getDb();
  return (await db.select().from(schema.devices).where(eq(schema.devices.id, device.id)))[0];
}

const code = (c: string) => (e: unknown) => e instanceof svc.ServiceError && e.code === c;

describe("canonical JSON", () => {
  test("sorts keys at every level and drops undefined, so both ends sign the same bytes", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined }, e: null }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1,"e":null}');
    assert.equal(canonicalJson("x"), '"x"');
  });
});

describe("pairing", () => {
  test("a machine is paired by a code the person approves; the daemon gets its id and the server's key once", async () => {
    const m = machine();
    const start = await d.startPairing({ publicKey: m.publicKey, name: "Atharva's MacBook Pro", os: "darwin" }, ctx);
    assert.match(start.userCode, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.equal(start.verificationUriComplete, `https://wh.example/devices/pair?code=${start.userCode}`);
    assert.equal((await d.pollPairing({ deviceCode: start.deviceCode })).status, "pending");
    assert.equal((await d.pollPairing({ deviceCode: start.deviceCode })).status, "slow_down", "polling faster than the interval");

    const peek = await d.peekPairing(owner, start.userCode.toLowerCase().replace("-", ""));
    assert.equal(peek.name, "Atharva's MacBook Pro");
    const { device } = await d.approvePairing(owner, start.userCode, { name: "MBP" });
    assert.equal(device.name, "MBP");

    const poll = await d.pollPairing({ deviceCode: start.deviceCode });
    assert.equal(poll.status, "approved");
    if (poll.status !== "approved") return;
    assert.equal(poll.deviceId, device.id);
    assert.ok(publicKeyFromRaw(poll.serverPublicKey));
    assert.equal((await d.pollPairing({ deviceCode: start.deviceCode })).status, "expired", "handed over once");
    await assert.rejects(d.approvePairing(owner, start.userCode), code("not_found"), "a used code is gone");
  });

  test("a denied pairing says so; a bad key, a wrong code and a viewer are refused", async () => {
    const start = await d.startPairing({ publicKey: machine().publicKey, name: "x", os: "linux" }, ctx);
    await assert.rejects(d.peekPairing(viewer, start.userCode), code("forbidden"));
    await d.denyPairing(owner, start.userCode);
    assert.equal((await d.pollPairing({ deviceCode: start.deviceCode })).status, "denied");
    await assert.rejects(d.startPairing({ publicKey: "nope", name: "x", os: "linux" }, ctx), code("invalid"));
    await assert.rejects(d.approvePairing(owner, "BBBB-BBBB"), code("not_found"));
    assert.equal((await d.pollPairing({ deviceCode: "made-up" })).status, "expired");
  });
});

describe("device tokens", () => {
  test("an assertion signed by the device's key buys a token, once", async () => {
    const { device, privateKey } = await paired();
    const a = assertion(device.id, privateKey);
    const t = await d.exchangeAssertion({ assertion: a }, ctx);
    assert.match(t.accessToken, /^whd_/);
    assert.equal((await d.deviceForToken(`Bearer ${t.accessToken}`)).id, device.id);
    await assert.rejects(d.exchangeAssertion({ assertion: a }, ctx), d.DeviceAuthError, "replayed");
  });

  test("another key, the wrong audience, a stale or long-lived assertion are all refused", async () => {
    const { device, privateKey } = await paired();
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [
      assertion(device.id, machine().privateKey),
      assertion(device.id, privateKey, { aud: "elsewhere" }),
      assertion(device.id, privateKey, { iat: now - 900, exp: now - 700 }),
      assertion(device.id, privateKey, { exp: now + 3600 }),
      assertion(crypto.randomUUID(), privateKey),
      "not.a.jwt",
    ])
      await assert.rejects(d.exchangeAssertion({ assertion: bad }, ctx), d.DeviceAuthError);
    assert.equal(verifyAssertion("x.y.z", publicKeyFromRaw(rawPublicKey(crypto.createPublicKey(privateKey)))!), null);
  });

  test("an unpaired device's token stops working, and it cannot get another", async () => {
    const { device, privateKey, accessToken } = await paired();
    await d.revokeDevice(owner, device.id);
    await assert.rejects(d.deviceForToken(`Bearer ${accessToken}`), d.DeviceAuthError);
    await assert.rejects(d.exchangeAssertion({ assertion: assertion(device.id, privateKey) }, ctx), d.DeviceAuthError);
  });
});

describe("devices", () => {
  test("the first signed message after a restart does not wait on itself (the key is loaded outside the transaction)", async () => {
    const { device } = await paired();
    resetSigningKeyCache(); // as after a restart: the key is not in memory yet
    const r = await Promise.race([d.updateDevice(owner, device.id, { poolSize: 2 }), new Promise((res) => setTimeout(() => res("hung"), 5000))]);
    assert.notEqual(r, "hung");
  });

  test("a person sees and changes only their own devices; a pool size change goes to the daemon signed", async () => {
    const { device, poll } = await paired();
    assert.ok((await d.listDevices(owner)).some((x) => x.id === device.id));
    assert.ok(!(await d.listDevices(teammate)).some((x) => x.id === device.id));
    await assert.rejects(d.updateDevice(teammate, device.id, { poolSize: 2 }), code("not_found"));
    await assert.rejects(d.updateDevice(stranger, device.id, { name: "mine" }), code("not_found"));
    await assert.rejects(d.updateDevice(owner, device.id, { poolSize: 9 }), code("invalid"));

    const { device: v } = await d.updateDevice(owner, device.id, { poolSize: 2 });
    assert.equal(v.poolSize, 2);
    const db = await getDb();
    const [m] = await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id));
    assert.equal(m.type, "settings.update");
    assert.equal(m.message.poolSize, 2);
    assert.equal(m.message.deviceId, device.id, "the message names its device, so it cannot be replayed to another");
    if (poll.status === "approved") assert.ok(verifyValue(publicKeyFromRaw(poll.serverPublicKey)!, m.message, m.signature));
  });

  test("hello records what the machine can do, keeping only known fields", async () => {
    const { device } = await paired();
    await d.deviceHello(device, { version: "0.1.0", capabilities: { claude: { installed: true, signedIn: true, models: ["opus"], email: "leak@example.com" }, secret: "x" }, jobs: [] });
    const [v] = (await d.listDevices(owner)).filter((x) => x.id === device.id);
    assert.equal(v.status, "online");
    assert.deepEqual(v.models, ["opus"]);
    assert.equal(JSON.stringify(v.capabilities).includes("leak"), false);
    assert.equal(JSON.stringify(v.capabilities).includes("secret"), false);
  });

  test("a device whose claude is missing offers no models, so nothing can be run on it", async () => {
    const { device } = await paired();
    await d.deviceHello(device, { version: "0.1.0", capabilities: { claude: { installed: false } }, jobs: [] });
    const [v] = (await d.listDevices(owner)).filter((x) => x.id === device.id);
    assert.deepEqual(v.models, []);
    const issue = await svc.createIssue(owner, "DM", { title: "m" });
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" }), code("invalid"));
  });
});

describe("the device's stream", () => {
  test("replays its messages from Last-Event-ID, sends new ones live, and ends on abort", async () => {
    const { device } = await paired();
    await d.updateDevice(owner, device.id, { poolSize: 4 });
    const stop = new AbortController();
    const reader = d.deviceStream(device.id, null, stop.signal, { heartbeatMs: 60_000, recheckMs: 60_000 }).getReader();
    const dec = new TextDecoder();
    let text = "";
    const until = async (re: RegExp) => {
      while (!re.test(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${re}`);
        text += dec.decode(value);
      }
    };
    await until(/"poolSize":4/);
    const firstId = Number(/id: (\d+)/.exec(text)![1]);
    await d.updateDevice(owner, device.id, { poolSize: 5 });
    await until(/"poolSize":5/);
    assert.match(text, /event: settings\.update/);
    stop.abort();
    assert.equal((await reader.read()).done, true);

    // Reconnecting after the first message sends only what came after it.
    const again = new AbortController();
    const r2 = d.deviceStream(device.id, firstId, again.signal, { heartbeatMs: 60_000, recheckMs: 60_000 }).getReader();
    let t2 = "";
    while (!/"poolSize":5/.test(t2)) t2 += dec.decode((await r2.read()).value);
    assert.equal(/"poolSize":4/.test(t2), false);
    again.abort();
  });
});

describe("jobs", () => {
  test("run on device: a signed offer with the issue and the repository, accepted, run, and finished", async () => {
    const { device, poll } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "Fix the login page", body: "It 500s" });
    const runnable = await d.issueJobs(owner, issue.ref);
    assert.deepEqual(runnable.repositories.map((r) => [r.id, r.fullName]), [[repoId, "acme/app"]], "only the GitHub repository is runnable");
    assert.ok(runnable.devices.some((x) => x.id === device.id && x.status === "online"));

    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    assert.equal(job.state, "offered");
    assert.match(job.branch, new RegExp(`^wh/${issue.ref}-fix-the-login-page-[0-9a-f]{6}$`));

    const db = await getDb();
    const [offer] = await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id));
    assert.equal(offer.type, "job.offer");
    const msg = offer.message as { jobId: string; repository: { cloneUrl: string }; issue: { body: string }; boardAccess: string };
    assert.equal(msg.jobId, job.id);
    assert.equal(msg.repository.cloneUrl, "https://github.com/acme/app.git");
    assert.equal(msg.issue.body, "It 500s");
    assert.equal(msg.boardAccess, "none");
    if (poll.status === "approved") assert.ok(verifyValue(publicKeyFromRaw(poll.serverPublicKey)!, msg, offer.signature));

    await d.acceptJob(device, job.id);
    await assert.rejects(d.acceptJob(device, job.id), code("conflict"), "taken once");
    await d.recordJobEvents(device, job.id, { events: [{ seq: 0, at: new Date().toISOString(), type: "started", data: {} }, { seq: 1, at: new Date().toISOString(), type: "tool", data: { name: "Edit" } }] });
    await d.recordJobEvents(device, job.id, { events: [{ seq: 1, type: "tool", data: { name: "Edit" } }, { seq: 2, type: "text", data: { text: "done" } }] });
    const ev = await d.jobEvents(owner, job.id);
    assert.equal(ev.job.state, "running");
    assert.deepEqual(ev.events.map((e) => e.seq), [0, 1, 2], "a resent event is stored once");
    assert.deepEqual((await d.jobEvents(owner, job.id, { after: 1 })).events.map((e) => e.seq), [2]);

    await d.finishJob(device, job.id, { state: "succeeded", commit: "abc1234", pushed: true, diffStats: { files: 2, insertions: 10, deletions: 3 }, costUsd: 0.4 });
    const done = (await d.issueJobs(teammate, issue.ref)).jobs.find((j) => j.id === job.id)!;
    assert.equal(done.state, "succeeded");
    assert.equal(done.result.commit, "abc1234");
    await d.finishJob(device, job.id, { state: "succeeded" }); // the same finish again is fine
    await assert.rejects(d.recordJobEvents(device, job.id, { events: [{ seq: 3, type: "x" }] }), code("conflict"));
  });

  test("refused: an offline device, someone else's device, a model it lacks, a viewer, and another workspace", async () => {
    const { device } = await paired();
    const issue = await svc.createIssue(owner, "DM", { title: "x" });
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" }), code("conflict"), "offline");
    await online(device);
    await assert.rejects(d.runOnDevice(teammate, issue.ref, { deviceId: device.id, model: "opus" }), code("invalid"), "not their device");
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "haiku" }), code("invalid"), "not offered by it");
    await assert.rejects(d.runOnDevice(viewer, issue.ref, { deviceId: device.id, model: "opus" }), code("forbidden"));
    await assert.rejects(d.runOnDevice(stranger, issue.ref, { deviceId: device.id, model: "opus" }), code("not_found"));
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", repositoryId: crypto.randomUUID() }), code("invalid"));
  });

  test("another device cannot touch the job", async () => {
    const a = await paired();
    const b = await paired();
    await online(a.device);
    const issue = await svc.createIssue(owner, "DM", { title: "y" });
    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: a.device.id, model: "opus" });
    await assert.rejects(d.acceptJob(b.device, job.id), code("not_found"));
    await assert.rejects(d.jobEvents(stranger, job.id), code("not_found"));
  });

  test("an offer nobody takes expires; a silent device's job is lost; a restart that forgot a job loses it", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "z" });
    const { job: offered } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.sweepDeviceJobs(new Date(Date.now() + d.OFFER_TTL_MS + 1000));
    assert.equal((await d.jobEvents(owner, offered.id)).job.state, "expired");
    await assert.rejects(d.acceptJob(device, offered.id), code("conflict"));

    const { job: running } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.acceptJob(device, running.id);
    await d.sweepDeviceJobs(new Date(Date.now() + 10_000));
    assert.equal((await d.jobEvents(owner, running.id)).job.state, "accepted", "still heard from");
    await d.sweepDeviceJobs(new Date(Date.now() + d.LOST_AFTER_MS + 1000));
    assert.equal((await d.jobEvents(owner, running.id)).job.state, "lost");

    await online(device);
    const { job: forgotten } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.acceptJob(device, forgotten.id);
    await d.deviceHello(device, { version: "0.1.0", capabilities: {}, jobs: [] });
    assert.equal((await d.jobEvents(owner, forgotten.id)).job.state, "lost");
  });

  test("cancel: an offer ends at once; a running job is asked to stop with a signed cancel and ends when the daemon says so", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "c" });
    const { job: a } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    assert.equal((await d.cancelJob(owner, a.id)).job.state, "canceled");

    const { job: b } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.acceptJob(device, b.id);
    await assert.rejects(d.cancelJob(teammate, b.id), code("forbidden"));
    const asked = await d.cancelJob(owner, b.id);
    assert.equal(asked.job.state, "accepted");
    assert.equal(asked.job.cancelRequested, true);
    const db = await getDb();
    const msgs = await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id));
    assert.ok(msgs.some((m) => m.type === "job.cancel" && m.message.jobId === b.id));
    await d.finishJob(device, b.id, { state: "canceled" });
    assert.equal((await d.jobEvents(owner, b.id)).job.state, "canceled");
  });

  test("a rejected offer records why", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "r" });
    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.rejectJob(device, job.id, { reason: "no_free_slot" });
    const v = (await d.jobEvents(owner, job.id)).job;
    assert.equal(v.state, "rejected");
    assert.equal(v.error, "no_free_slot");
  });
});
