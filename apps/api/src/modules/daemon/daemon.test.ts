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
import { getDb, schema } from "../../db";
import type { Actor } from "../../lib/access";
import * as svc from "../../lib/service";
import * as d from "./internal";
import { GithubApiError } from "../../lib/github/api";
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

let machines = 0;

/** Pair a machine for `who`, and get it a token: what `wheelhouse-daemon pair` and its first connect do. */
async function paired(who: Actor = owner) {
  const m = machine();
  // Each machine pairs from its own address, so the per-address pairing limit is not what a long test file runs into.
  const start = await d.startPairing({ publicKey: m.publicKey, name: "Laptop", os: "darwin" }, { ...ctx, ip: `10.0.0.${++machines}` });
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

/** The parts of a job offer these tests read. */
type Offer = { jobId: string; startFrom: string; previous: { jobId: string; state: string; summary: string | null; error: string | null } | null };

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

describe("what a run delivered", () => {
  test("nothing, a pushed branch, an open pull request, or a refused one; nothing to say until it ends", () => {
    assert.equal(d.jobDelivery("succeeded", { pushed: false }), "none");
    assert.equal(d.jobDelivery("succeeded", {}), "none");
    assert.equal(d.jobDelivery("succeeded", { pushed: true }), "pushed");
    assert.equal(d.jobDelivery("succeeded", { pushed: true, pullRequest: { number: 3, url: "u" } }), "pr_opened");
    assert.equal(d.jobDelivery("succeeded", { pushed: true, pullRequestError: "GitHub refused" }), "pr_failed");
    // No GitHub App means no pull request was expected: that is a push, not a failure.
    assert.equal(d.jobDelivery("succeeded", { pushed: true, pullRequestSkipped: "App not set up" }), "pushed");
    // A stopped or failed run still pushes what it had.
    assert.equal(d.jobDelivery("canceled", { pushed: true }), "pushed");
    assert.equal(d.jobDelivery("failed", { pushed: false }), "none");
    for (const s of ["offered", "accepted", "running", "rejected", "expired", "lost"] as const) assert.equal(d.jobDelivery(s, {}), null, s);
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
    const msg = offer.message as { jobId: string; repository: { cloneUrl: string }; issue: { body: string }; boardAccess: string; baseBranch: string };
    assert.equal(msg.jobId, job.id);
    assert.equal(msg.repository.cloneUrl, "https://github.com/acme/app.git");
    assert.equal(msg.issue.body, "It 500s");
    assert.equal(msg.boardAccess, "none");
    assert.equal(msg.baseBranch, "main", "the repository's default branch unless another is picked");
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
    assert.equal(done.delivery, "pushed");
    assert.equal(done.result.commit, "abc1234");
    await d.finishJob(device, job.id, { state: "succeeded" }); // the same finish again is fine
    await assert.rejects(d.recordJobEvents(device, job.id, { events: [{ seq: 3, type: "x" }] }), code("conflict"));
  });

  test("a run that pushed changes gets a pull request from the App, once; a refusal is recorded and the run still succeeds", async () => {
    const db = await getDb();
    await db.update(schema.repositories).set({ githubInstallationId: "77" }).where(eq(schema.repositories.id, repoId));
    try {
      const { device } = await paired();
      await online(device);
      const calls: { installationId: string; repoId: string; pr: { title: string; head: string; base: string; body: string } }[] = [];
      const gh = { api: { openPullRequest: async (installationId: string, repoId: string, pr: (typeof calls)[number]["pr"]) => (calls.push({ installationId, repoId, pr }), { number: 42, url: "https://github.com/acme/app/pull/42" }) } };
      const run = async (title: string) => {
        const issue = await svc.createIssue(owner, "DM", { title });
        const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", baseBranch: "develop" });
        await d.acceptJob(device, job.id);
        return { issue, job };
      };

      const { issue, job } = await run("Add dark mode");
      const done = { state: "succeeded", commit: "abc1234", pushed: true, diffStats: { files: 3, insertions: 20, deletions: 1 }, costUsd: 1.25 };
      await d.finishJob(device, job.id, done, gh);
      await d.finishJob(device, job.id, done, gh); // sent again
      assert.equal(calls.length, 1, "one pull request, however often the finish arrives");
      assert.deepEqual([calls[0].installationId, calls[0].repoId, calls[0].pr.head, calls[0].pr.base], ["77", "1234", job.branch, "develop"]);
      assert.equal(calls[0].pr.title, `${issue.ref}: Add dark mode`, "the ref in the title links it to the issue");
      assert.match(calls[0].pr.body, /Run on Laptop with opus · 3 files, \+20 −1 · ~\$1\.25/);
      const view = (await d.issueJobs(owner, issue.ref)).jobs.find((j) => j.id === job.id)!;
      assert.deepEqual(view.result.pullRequest, { number: 42, url: "https://github.com/acme/app/pull/42" });
      assert.equal(view.result.commit, "abc1234", "the rest of the result is kept");

      const nothing = await run("Nothing to change");
      await d.finishJob(device, nothing.job.id, { state: "succeeded", commit: "abc1234", pushed: true, diffStats: { files: 0, insertions: 0, deletions: 0 } }, gh);
      const failed = await run("Breaks halfway");
      await d.finishJob(device, failed.job.id, { state: "failed", commit: "abc1234", pushed: true, error: "boom" }, gh);
      assert.equal(calls.length, 1, "no pull request without changes, or for a run that failed");

      const refused = await run("No permission");
      const deny = { api: { openPullRequest: async () => Promise.reject(new GithubApiError("GitHub POST answered 403", 403)) } };
      const res = await d.finishJob(device, refused.job.id, done, deny);
      assert.equal(res.job.state, "succeeded");
      const r = (await d.issueJobs(owner, refused.issue.ref)).jobs.find((j) => j.id === refused.job.id)!;
      assert.match(r.result.pullRequestError as string, /Pull requests: Read and write/);
    } finally {
      await db.update(schema.repositories).set({ githubInstallationId: null }).where(eq(schema.repositories.id, repoId));
    }
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

  test("a run can start from another branch; a name that is not a branch is refused", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "base" });
    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", baseBranch: "staging" });
    assert.equal(job.baseBranch, "staging");
    const db = await getDb();
    const [m] = await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id));
    assert.equal(m.message.baseBranch, "staging");
    for (const bad of ["../etc", "-x", "a b", "a..b", "x.lock", "a@{1}"]) await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", baseBranch: bad }), code("invalid"), bad);
    // Without the GitHub App, only the default branch is known.
    assert.deepEqual(await d.runBranches(owner, issue.ref, repoId), { defaultBranch: "main", branches: ["main"], listed: false });
  });

  test("continue: a new run on the earlier run's branch, from its commits, keeping its base, told what the last one said", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "continue me" });
    const { job: first } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", baseBranch: "staging" });
    await d.acceptJob(device, first.id);
    await d.recordJobEvents(device, first.id, { events: [{ seq: 0, type: "started" }, { seq: 1, type: "result", data: { text: "Edited a.ts; tests still failing" } }] });
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", continuesJobId: first.id }), code("conflict"), "not finished yet");
    await d.finishJob(device, first.id, { state: "failed", pushed: true, commit: "abc1234", error: "timed out" });

    const { job: next } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "sonnet", continuesJobId: first.id, baseBranch: "ignored" });
    assert.equal(next.branch, first.branch, "the same branch");
    assert.equal(next.baseBranch, "staging", "the first run's base, which its pull request targets");
    assert.equal(next.continuesJobId, first.id);
    const db = await getDb();
    const offers = await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id));
    const offer = offers.map((o) => o.message as Offer).find((m) => m.jobId === next.id)!;
    assert.equal(offer.startFrom, first.branch);
    assert.deepEqual(offer.previous, { jobId: first.id, state: "failed", summary: "Edited a.ts; tests still failing", error: "timed out" });
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", continuesJobId: first.id }), code("conflict"), "a second run on the same branch");

    // A run that pushed nothing has nothing to continue from; a run of another issue is not this issue's.
    const { job: empty } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.rejectJob(device, empty.id, { reason: "no_free_slot" });
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", continuesJobId: empty.id }), code("invalid"));
    const other = await svc.createIssue(owner, "DM", { title: "other" });
    await assert.rejects(d.runOnDevice(owner, other.ref, { deviceId: device.id, model: "opus", continuesJobId: first.id }), code("invalid"));

    // A stopped or lost run can be continued even though it pushed nothing: the new run keeps its branch and starts from its base.
    const { job: stopped } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", baseBranch: "staging" });
    await d.acceptJob(device, stopped.id);
    await d.finishJob(device, stopped.id, { state: "canceled", pushed: false });
    const { job: resumed } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", continuesJobId: stopped.id });
    assert.equal(resumed.branch, stopped.branch);
    const offers2 = await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id));
    assert.equal(offers2.map((o) => o.message as Offer).find((m) => m.jobId === resumed.id)!.startFrom, "staging");
  });

  test("a fresh run starts from its base", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "fresh" });
    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", baseBranch: "staging" });
    assert.equal(job.continuesJobId, null);
    const db = await getDb();
    const offer = (await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id))).map((o) => o.message as Offer).find((m) => m.jobId === job.id)!;
    assert.equal(offer.startFrom, "staging");
    assert.equal(offer.previous, null);
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

  test("an offer nobody takes expires; a silent device's job turns unreachable, never lost; a restart that forgot a job loses it", async () => {
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
    await d.sweepDeviceJobs(new Date(Date.now() + d.UNREACHABLE_AFTER_MS + 1000));
    const quiet = (await d.jobEvents(owner, running.id)).job;
    assert.equal(quiet.state, "unreachable");
    assert.ok(quiet.unreachableSince && quiet.lastHeardAt);
    await d.sweepDeviceJobs(new Date(Date.now() + 30 * 24 * 3600e3));
    assert.equal((await d.jobEvents(owner, running.id)).job.state, "unreachable", "no amount of silence loses it");

    await online(device);
    const { job: forgotten } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.acceptJob(device, forgotten.id);
    await d.deviceHello(device, { version: "0.1.0", capabilities: {}, jobs: [] });
    assert.equal((await d.jobEvents(owner, forgotten.id)).job.state, "lost");
  });

  test("an unreachable run comes back when the daemon reports it, and is lost when the daemon says it no longer has it", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "back" });
    const start = async () => {
      const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
      await d.acceptJob(device, job.id);
      await d.recordJobEvents(device, job.id, { events: [{ seq: 0, type: "started" }] });
      return job;
    };
    const quiet = async () => void (await d.sweepDeviceJobs(new Date(Date.now() + d.UNREACHABLE_AFTER_MS + 1000)));
    const state = async (id: string) => (await d.jobEvents(owner, id)).job.state;

    const a = await start();
    await quiet();
    assert.equal(await state(a.id), "unreachable");
    await d.deviceHeartbeat(device, { running: [a.id], free: 0 });
    assert.equal(await state(a.id), "running", "a heartbeat that lists it");

    await quiet();
    await d.deviceHello(device, { version: "0.1.0", capabilities: {}, jobs: [{ id: a.id, state: "running" }] });
    assert.equal(await state(a.id), "running", "a hello that lists it");

    await quiet();
    await d.deviceHeartbeat(device, { running: [], free: 1 });
    const gone = (await d.jobEvents(owner, a.id)).job;
    assert.equal(gone.state, "lost", "a heartbeat that leaves it out");
    assert.equal(gone.markedLost, false);

    // Progress from the device is proof of life too, and an unreachable run can still finish with its real outcome.
    const b = await start();
    await quiet();
    await d.recordJobEvents(device, b.id, { events: [{ seq: 1, type: "tool" }] });
    assert.equal(await state(b.id), "running");
    await quiet();
    await d.finishJob(device, b.id, { state: "succeeded", pushed: false }, null);
    assert.equal(await state(b.id), "succeeded");
  });

  test("marking an unreachable run lost: only unreachable, by someone who may; the device reporting it brings it back", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "mark" });
    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.acceptJob(device, job.id);
    await d.recordJobEvents(device, job.id, { events: [{ seq: 0, type: "started" }] });
    await assert.rejects(d.markJobLost(owner, job.id), code("conflict"), "a run that is running is not unreachable");
    await d.sweepDeviceJobs(new Date(Date.now() + d.UNREACHABLE_AFTER_MS + 1000));
    await assert.rejects(d.markJobLost(stranger, job.id), code("not_found"));
    const lost = (await d.markJobLost(owner, job.id)).job;
    assert.equal(lost.state, "lost");
    assert.equal(lost.markedLost, true);
    assert.match(lost.error ?? "", /Marked lost by/);

    // Nobody took the branch over: the device reporting the run brings it back to running.
    await d.deviceHeartbeat(device, { running: [job.id], free: 0 });
    const back = (await d.jobEvents(owner, job.id)).job;
    assert.equal(back.state, "running");
    assert.equal(back.markedLost, false);
    assert.equal(back.error, null);

    // Marked again, then its progress arrives: also back.
    await d.sweepDeviceJobs(new Date(Date.now() + d.UNREACHABLE_AFTER_MS + 1000));
    await d.markJobLost(owner, job.id);
    await d.recordJobEvents(device, job.id, { events: [{ seq: 1, type: "tool" }] });
    assert.equal((await d.jobEvents(owner, job.id)).job.state, "running");

    // Marked again, and it finishes: the real outcome replaces lost, and the pull request opens as for any run.
    await d.sweepDeviceJobs(new Date(Date.now() + d.UNREACHABLE_AFTER_MS + 1000));
    await d.markJobLost(owner, job.id);
    await d.finishJob(device, job.id, { state: "failed", pushed: true, commit: "abc1234", diffStats: { files: 1 }, error: "tests failed" }, null);
    const done = (await d.jobEvents(owner, job.id)).job;
    assert.equal(done.state, "failed");
    assert.equal(done.result.pushed, true);
    assert.equal(done.markedLost, false);
  });

  test("a marked-lost run that was continued meanwhile is stopped, not revived, and keeps its result without a pull request", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await svc.createIssue(owner, "DM", { title: "takeover" });
    const { job: old } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.acceptJob(device, old.id);
    await d.recordJobEvents(device, old.id, { events: [{ seq: 0, type: "started" }] });
    await d.sweepDeviceJobs(new Date(Date.now() + d.UNREACHABLE_AFTER_MS + 1000));
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", continuesJobId: old.id }), code("conflict"), "cannot continue what may still be running");
    await d.markJobLost(owner, old.id);
    await online(device);
    const { job: next } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", continuesJobId: old.id });
    assert.equal(next.branch, old.branch);

    const db = await getDb();
    const cancels = async () => (await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id))).map((m) => m.message as { type: string; jobId: string; superseded?: boolean }).filter((m) => m.type === "job.cancel" && m.jobId === old.id);
    await d.deviceHeartbeat(device, { running: [old.id], free: 0 });
    assert.equal((await d.jobEvents(owner, old.id)).job.state, "lost", "not revived");
    assert.deepEqual((await cancels()).map((m) => m.superseded), [true], "told to stop");
    await d.deviceHeartbeat(device, { running: [old.id], free: 0 });
    await assert.rejects(d.recordJobEvents(device, old.id, { events: [{ seq: 1, type: "tool" }] }), code("conflict"));
    assert.equal((await cancels()).length, 1, "asked once");

    // It stops and reports what it did: recorded, marked as superseded, no pull request.
    let opened = 0;
    const gh = { api: { openPullRequest: async () => (opened++, { number: 1, url: "https://github.com/x/y/pull/1" }) } } as never;
    await d.finishJob(device, old.id, { state: "canceled", pushed: true, commit: "abc1234", diffStats: { files: 2 }, error: "Superseded" }, gh);
    const view = (await d.jobEvents(owner, old.id)).job;
    assert.equal(view.state, "canceled");
    assert.equal(view.result.supersededBy, next.id);
    assert.equal(view.result.pullRequest, undefined);
    assert.equal(opened, 0);
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
