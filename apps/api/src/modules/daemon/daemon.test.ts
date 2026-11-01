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

import { before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { sha256 } from "../../common/crypto";
import { createIssue } from "../issues/issues.legacy";
import { createTeam } from "../teams/teams.legacy";
import { DeviceAuthError } from "./daemon-errors";
import { DeviceAuthService } from "./device-auth.service";
import { DeviceJobsService } from "./device-jobs.service";
import { DeviceStreamService } from "./device-stream.service";
import { DevicesService } from "./devices.service";
import { RunsService } from "./runs.service";
import { DelegationService } from "./delegation.service";
import { LearningsService } from "./learnings.service";
import { DaemonRepository } from "./daemon.repository";
import { IssuesService } from "../issues/index";
import { updateIssue } from "../issues/issues.legacy";
import { jobDelivery } from "./daemon.presenter";
import { OFFER_TTL_MS, UNREACHABLE_AFTER_MS, type Device } from "./device-common";
import { GithubApiError } from "../github/api";
import { ASSERTION_AUDIENCE, canonicalJson, publicKeyFromRaw, rawPublicKey, verifyAssertion, verifyValue } from "./daemon-crypto";
import { NotificationsService } from "../notifications/index";
import { testApp } from "../../test/app";
const app = await testApp();
const auth = app.get(DeviceAuthService);
const jobs = app.get(DeviceJobsService);
const stream = app.get(DeviceStreamService);
const devices = app.get(DevicesService);
const runs = app.get(RunsService);

/** The services' methods under the names these tests were written with. */
const d = {
  OFFER_TTL_MS,
  UNREACHABLE_AFTER_MS,
  jobDelivery,
  startPairing: auth.startPairing.bind(auth),
  pollPairing: auth.pollPairing.bind(auth),
  exchangeAssertion: auth.exchangeAssertion.bind(auth),
  deviceForToken: auth.deviceForToken.bind(auth),
  deviceHello: jobs.hello.bind(jobs),
  deviceHeartbeat: jobs.heartbeat.bind(jobs),
  acceptJob: jobs.acceptJob.bind(jobs),
  rejectJob: jobs.rejectJob.bind(jobs),
  recordJobEvents: jobs.recordJobEvents.bind(jobs),
  finishJob: jobs.finishJob.bind(jobs),
  sweepDeviceJobs: jobs.sweep.bind(jobs),
  deviceStream: stream.stream.bind(stream),
  listDevices: devices.listDevices.bind(devices),
  peekPairing: devices.peekPairing.bind(devices),
  approvePairing: devices.approvePairing.bind(devices),
  denyPairing: devices.denyPairing.bind(devices),
  updateDevice: devices.updateDevice.bind(devices),
  revokeDevice: devices.revokeDevice.bind(devices),
  issueJobs: runs.issueJobs.bind(runs),
  runBranches: runs.runBranches.bind(runs),
  runOnDevice: runs.runOnDevice.bind(runs),
  jobEvents: runs.jobEvents.bind(runs),
  cancelJob: runs.cancelJob.bind(runs),
  markJobLost: runs.markJobLost.bind(runs),
};

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
  const team = await createTeam(owner, { name: "Daemon", key: "DM" });
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
async function online(device: Device, models = ["opus", "sonnet"]) {
  await d.deviceHello(device, { version: "0.1.0", capabilities: { claude: { installed: true, signedIn: true, models }, repositories: [] }, jobs: [] });
  const db = await getDb();
  return (await db.select().from(schema.devices).where(eq(schema.devices.id, device.id)))[0];
}

/** The parts of a job offer these tests read. */
type Offer = { jobId: string; startFrom: string; previous: { jobId: string; state: string; summary: string | null; error: string | null } | null };

const code = (c: string) => (e: unknown) => e instanceof ServiceError && e.code === c;

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

  test("a denied pairing says so; a bad key and a wrong code are refused", async () => {
    const start = await d.startPairing({ publicKey: machine().publicKey, name: "x", os: "linux" }, ctx);
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
    await assert.rejects(d.exchangeAssertion({ assertion: a }, ctx), DeviceAuthError, "replayed");
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
      await assert.rejects(d.exchangeAssertion({ assertion: bad }, ctx), DeviceAuthError);
    assert.equal(verifyAssertion("x.y.z", publicKeyFromRaw(rawPublicKey(crypto.createPublicKey(privateKey)))!), null);
  });

  test("an unpaired device's token stops working, and it cannot get another", async () => {
    const { device, privateKey, accessToken } = await paired();
    await d.revokeDevice(owner, device.id);
    await assert.rejects(d.deviceForToken(`Bearer ${accessToken}`), DeviceAuthError);
    await assert.rejects(d.exchangeAssertion({ assertion: assertion(device.id, privateKey) }, ctx), DeviceAuthError);
  });
});

describe("devices", () => {
  test("the first signed message after a restart does not wait on itself (the key is loaded outside the transaction)", async () => {
    const { device } = await paired();
    stream.resetSigningKey(); // as after a restart: the key is not in memory yet
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
    const issue = await createIssue(owner, "DM", { title: "m" });
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
    const issue = await createIssue(owner, "DM", { title: "Fix the login page", body: "It 500s" });
    const runnable = await d.issueJobs(owner, issue.ref);
    assert.deepEqual(runnable.repositories.map((r) => [r.id, r.fullName]), [[repoId, "acme/app"]], "only the GitHub repository is runnable");
    assert.ok(runnable.devices.some((x) => x.id === device.id && x.status === "online"));

    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    assert.equal(job.state, "offered");
    assert.match(job.branch, new RegExp(`^wh/${issue.ref}-fix-the-login-page-[0-9a-f]{6}$`));

    const db = await getDb();
    const [offer] = await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id));
    assert.equal(offer.type, "job.offer");
    const msg = offer.message as { jobId: string; repository: { cloneUrl: string }; issue: { body: string }; boardAccess: string; baseBranch: string; mcp: { token: string } };
    assert.equal(msg.jobId, job.id);
    assert.equal(msg.repository.cloneUrl, "https://github.com/acme/app.git");
    assert.equal(msg.issue.body, "It 500s");
    assert.equal(msg.boardAccess, "read");
    const runKey = () => db.select().from(schema.apiKeys).where(eq(schema.apiKeys.chatMessageId, job.id));
    const [key] = await runKey();
    assert.equal(key.keyHash, sha256(msg.mcp.token), "the run reads Wheelhouse with its own key");
    assert.deepEqual(key.capabilities, ["read"], "read-only");
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
    assert.equal((await runKey()).length, 0, "the key goes when the run ends");
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
        const issue = await createIssue(owner, "DM", { title });
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
      assert.deepEqual(view.pullRequest, { number: 42, url: "https://github.com/acme/app/pull/42", state: null, ciState: null }, "state unknown until the webhook has told us");
      await db.insert(schema.pullRequests).values({ repositoryId: repoId, number: 42, title: "t", url: "https://github.com/acme/app/pull/42", state: "merged", ciState: "success" });
      const live = (await d.issueJobs(owner, issue.ref)).jobs.find((j) => j.id === job.id)!;
      assert.deepEqual([live.pullRequest?.state, live.pullRequest?.ciState], ["merged", "success"], "the live state is joined, not copied into the result");

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
    const issue = await createIssue(owner, "DM", { title: "x" });
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" }), code("conflict"), "offline");
    await online(device);
    await assert.rejects(d.runOnDevice(teammate, issue.ref, { deviceId: device.id, model: "opus" }), code("invalid"), "not their device");
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "haiku" }), code("invalid"), "not offered by it");
    await assert.rejects(d.runOnDevice(viewer, issue.ref, { deviceId: device.id, model: "opus" }), code("forbidden"));
    await assert.rejects(d.runOnDevice(stranger, issue.ref, { deviceId: device.id, model: "opus" }), code("not_found"));
    await assert.rejects(d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus", repositoryId: crypto.randomUUID() }), code("invalid"));
  });

  test("one device runs jobs from two workspaces, and stops getting work from one the person leaves", async () => {
    const db = await getDb();
    const { device } = await paired();
    await online(device);
    const [wsB] = await db.insert(schema.workspaces).values({ name: "Second workspace" }).returning();
    await db.insert(schema.memberships).values({ userId: owner.id, workspaceId: wsB.id, role: "owner" });
    const inB: Actor = { ...owner, workspaceId: wsB.id };
    const teamB = await createTeam(inB, { name: "Second", key: "SB" });
    await db.insert(schema.repositories).values({ teamId: teamB.id, workspaceId: wsB.id, displayName: "b", role: "app", provider: "github", slug: "5678", githubRepoId: "5678", githubFullName: "acme/b", defaultBranch: "main" });
    const a = await d.runOnDevice(owner, (await createIssue(owner, "DM", { title: "in A" })).ref, { deviceId: device.id, model: "opus" });
    const issueB = await createIssue(inB, "SB", { title: "in B" });
    const b = await d.runOnDevice(inB, issueB.ref, { deviceId: device.id, model: "opus" });
    assert.deepEqual(
      (await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id))).map((m) => m.message.workspaceId),
      [owner.workspaceId, wsB.id],
      "each offer names its workspace",
    );
    assert.notEqual(a.job.id, b.job.id);
    await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, owner.id), eq(schema.memberships.workspaceId, wsB.id)));
    await assert.rejects(d.runOnDevice(inB, issueB.ref, { deviceId: device.id, model: "opus" }), (e: unknown) => e instanceof ServiceError);
    assert.equal((await d.runOnDevice(owner, (await createIssue(owner, "DM", { title: "still A" })).ref, { deviceId: device.id, model: "opus" })).job.state, "offered");
  });

  test("a run can start from another branch; a name that is not a branch is refused", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "base" });
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
    const issue = await createIssue(owner, "DM", { title: "continue me" });
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
    const other = await createIssue(owner, "DM", { title: "other" });
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
    const issue = await createIssue(owner, "DM", { title: "fresh" });
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
    const issue = await createIssue(owner, "DM", { title: "y" });
    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: a.device.id, model: "opus" });
    await assert.rejects(d.acceptJob(b.device, job.id), code("not_found"));
    await assert.rejects(d.jobEvents(stranger, job.id), code("not_found"));
  });

  test("an offer nobody takes expires; a silent device's job turns unreachable, never lost; a restart that forgot a job loses it", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "z" });
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
    const issue = await createIssue(owner, "DM", { title: "back" });
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
    const issue = await createIssue(owner, "DM", { title: "mark" });
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
    const issue = await createIssue(owner, "DM", { title: "takeover" });
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

  test("self-check (WH-170/171): the offer carries the repository's checks; a required check that failed or could not run means no pull request", async () => {
    const db = await getDb();
    const checks = [{ name: "lint", command: "pnpm lint", required: true }];
    await db.update(schema.repositories).set({ githubInstallationId: "77", checks }).where(eq(schema.repositories.id, repoId));
    try {
      const { device } = await paired();
      await online(device);
      let opened = 0;
      const gh = { api: { openPullRequest: async () => (opened++, { number: 1, url: "https://github.com/x/y/pull/1" }) } } as never;
      const run = async (title: string) => {
        const issue = await createIssue(owner, "DM", { title });
        const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
        await d.acceptJob(device, job.id);
        return { issue, job };
      };
      const done = { state: "succeeded", commit: "abc1234", pushed: true, diffStats: { files: 1 } };
      const lint = { name: "lint", command: "pnpm lint", required: true, exitCode: 1, durationMs: 900, tail: "1 error" };

      const a = await run("Lint error");
      const offer = (await db.select().from(schema.deviceMessages).where(eq(schema.deviceMessages.deviceId, device.id))).map((m) => m.message as { type: string; jobId: string; repository: { checks: unknown } }).find((m) => m.type === "job.offer" && m.jobId === a.job.id)!;
      assert.deepEqual(offer.repository.checks, checks);
      await d.finishJob(device, a.job.id, { ...done, checks: [{ ...lint, status: "failed" }] }, gh);
      const failed = (await d.jobEvents(owner, a.job.id)).job;
      assert.equal(opened, 0, "no pull request");
      assert.match(failed.result.pullRequestSkipped as string, /"lint" failed/);
      assert.deepEqual((failed.result.checks as { status: string; tail: string }[]).map((c) => [c.status, c.tail]), [["failed", "1 error"]], "the result lists the check and its outcome");

      const b = await run("Lint could not run");
      await d.finishJob(device, b.job.id, { ...done, checks: [{ ...lint, status: "could_not_run", exitCode: null }] }, gh);
      assert.equal(opened, 0);

      const c = await run("Lint passes");
      await d.finishJob(device, c.job.id, { ...done, checks: [{ ...lint, status: "passed", exitCode: 0 }] }, gh);
      assert.equal(opened, 1, "all required checks passed");
    } finally {
      await db.update(schema.repositories).set({ githubInstallationId: null, checks: [] }).where(eq(schema.repositories.id, repoId));
    }
  });

  test("cancel: an offer ends at once; a running job is asked to stop with a signed cancel and ends when the daemon says so", async () => {
    const { device } = await paired();
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "c" });
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
    const issue = await createIssue(owner, "DM", { title: "r" });
    const { job } = await d.runOnDevice(owner, issue.ref, { deviceId: device.id, model: "opus" });
    await d.rejectJob(device, job.id, { reason: "no_free_slot" });
    const v = (await d.jobEvents(owner, job.id)).job;
    assert.equal(v.state, "rejected");
    assert.equal(v.error, "no_free_slot");
  });
});

describe("run notifications", () => {
  const inbox = app.get(NotificationsService);
  const mine = async (who: Actor, issueId: string) =>
    (await inbox.list({ userId: who.id, workspaceId: who.workspaceId }, { limit: 100 })).items.filter((i) => i.subjectId === issueId);

  /** A run the teammate started on a new issue, taken by the device and under way. */
  async function started() {
    const { device } = await paired(teammate);
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "Notify me" });
    const { job } = await d.runOnDevice(teammate, issue.ref, { deviceId: device.id, model: "opus" });
    await d.acceptJob(device, job.id);
    return { device, issue, job };
  }

  test("a finished run tells the person who started it, once; the same finish again, and another person, get nothing", async () => {
    const { device, issue, job } = await started();
    await d.finishJob(device, job.id, { state: "succeeded" });
    await d.finishJob(device, job.id, { state: "succeeded" });
    const items = await mine(teammate, issue.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, "run.finished");
    assert.equal(items[0].title, `Run on ${issue.ref} finished`);
    assert.equal(items[0].href, `/t/DM?t=${issue.ref}`);
    assert.equal(items[0].source, "wheelhouse");
    assert.equal(items[0].subjectEntity, "issue");
    assert.equal(items[0].actorKind, "agent");
    assert.equal(items[0].dedupeKey, `run.finished:${job.id}`);
    assert.deepEqual(await mine(owner, issue.id), [], "the issue's creator did not start the run");
  });

  test("a failed run says so with its error, and a second run on the same issue is a new item", async () => {
    const { device, issue, job } = await started();
    await d.finishJob(device, job.id, { state: "failed", error: "tests did not pass" });
    const second = await d.runOnDevice(teammate, issue.ref, { deviceId: device.id, model: "opus" });
    await d.acceptJob(device, second.job.id);
    await d.finishJob(device, second.job.id, { state: "succeeded" });
    const items = (await mine(teammate, issue.id)).sort((a, b) => a.type.localeCompare(b.type));
    assert.deepEqual(items.map((i) => i.type), ["run.failed", "run.finished"]);
    assert.match(items[0].body, /tests did not pass/);
  });

  test("a canceled run says nothing", async () => {
    const { device, issue, job } = await started();
    await d.finishJob(device, job.id, { state: "canceled" });
    assert.deepEqual(await mine(teammate, issue.id), []);
  });

  test("a notification that fails does not fail the finish", async () => {
    const { device, issue, job } = await started();
    const fail = mock.method(inbox, "notify", async () => {
      throw new Error("inbox is down");
    });
    try {
      const out = await d.finishJob(device, job.id, { state: "failed", error: "boom" });
      assert.equal(out.job.state, "failed");
      assert.equal(fail.mock.callCount(), 1);
    } finally {
      fail.mock.restore();
    }
    assert.equal((await d.jobEvents(owner, job.id)).job.state, "failed");
    assert.deepEqual(await mine(teammate, issue.id), []);
  });
});

describe("delegated runs (WH-116)", () => {
  /** A team member with a catalog agent on the team's roster to delegate to. */
  async function setup(name: string, catalog = "fullstack") {
    const db = await getDb();
    const who = await person(owner.workspaceId, name);
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.key, "DM"));
    await db.insert(schema.teamMembers).values({ teamId: team.id, userId: who.id, workspaceId: owner.workspaceId, role: "editor" });
    const slug = `remy-${name}`;
    const [agent] = await db.insert(schema.workspaceAgents).values({ workspaceId: owner.workspaceId, slug, source: "catalog", catalogSlug: catalog }).returning();
    await db.insert(schema.teamAgents).values({ teamId: team.id, workspaceId: owner.workspaceId, workspaceAgentId: agent.id });
    return { who, slug, agent };
  }
  const jobsOf = async (issueId: string) => (await getDb()).select().from(schema.deviceJobs).where(eq(schema.deviceJobs.issueId, issueId));

  test("delegating starts a run as the delegator, with the agent; clearing stops it", async () => {
    const { who, slug, agent } = await setup("dana");
    const { device } = await paired(who);
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "Delegate me", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    await updateIssue(who, issue.ref, { delegate: slug });
    const [job] = await jobsOf(issue.id);
    assert.equal(job.state, "offered");
    assert.equal(job.deviceId, device.id);
    assert.equal(job.createdBy, who.id, "the delegator is the requester");
    assert.equal(job.agentId, agent.id);
    const [offer] = await (await getDb()).select().from(schema.deviceMessages).where(and(eq(schema.deviceMessages.deviceId, device.id), eq(schema.deviceMessages.type, "job.offer")));
    const sent = (offer.message as { agent: { slug: string; name: string; definitions: Record<string, { prompt: string }> } | null }).agent!;
    assert.equal(sent.slug, slug);
    assert.match(sent.definitions[sent.name].prompt, /\S/, "the CLI agent definition carries the instructions (WH-115)");

    await updateIssue(who, issue.ref, { delegate: null });
    assert.equal((await jobsOf(issue.id))[0].state, "canceled");
  });

  test("the assignee can stop an admin's run, rerun it as theirs, and hears how it ends", async () => {
    const { who, slug } = await setup("ari");
    const { device } = await paired(owner);
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "Admin delegates", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    await updateIssue(owner, issue.ref, { delegate: slug });
    const [first] = await jobsOf(issue.id);
    assert.equal(first.createdBy, owner.id, "the admin who delegated is the requester");
    assert.equal((await d.cancelJob(who, first.id)).job.state, "canceled", "the assignee may stop it");

    const { device: mine } = await paired(who);
    await online(mine);
    await app.get(IssuesService).rerunDelegate(who, issue.ref);
    const second = (await jobsOf(issue.id)).find((j) => j.id !== first.id)!;
    assert.equal(second.createdBy, who.id, "a rerun makes the assignee the requester");
    await assert.rejects(app.get(IssuesService).rerunDelegate(teammate, issue.ref), code("forbidden"));
  });

  test("when the requester leaves the team, their run stops and the delegate is cleared", async () => {
    const { who, slug } = await setup("lee");
    const { device } = await paired(who);
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "Leaver", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    await updateIssue(who, issue.ref, { delegate: slug });
    const db = await getDb();
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, who.id));
    assert.ok((await app.get(DelegationService).stopOrphaned()) >= 1);
    assert.equal((await jobsOf(issue.id))[0].state, "canceled");
    const [row] = await db.select().from(schema.issues).where(eq(schema.issues.id, issue.id));
    assert.equal(row.delegateAgentId, null);
  });

  test("with no device online the issue waits, and is offered when one comes online", async () => {
    const { who, slug } = await setup("wes");
    const { device } = await paired(who);
    const issue = await createIssue(owner, "DM", { title: "Wait for me", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    await updateIssue(who, issue.ref, { delegate: slug });
    assert.deepEqual(await jobsOf(issue.id), []);
    await online(device);
    assert.ok((await app.get(DelegationService).offerWaiting()) >= 1);
    const [job] = await jobsOf(issue.id);
    assert.equal(job.createdBy, who.id);
    assert.equal(await app.get(DelegationService).offerWaiting(), 0, "an issue with a run since it was delegated no longer waits");
  });

  test("without targets the issue needs setup: one inbox item, no run, no retry; setting targets lets the sweep start it", async () => {
    const { who, slug } = await setup("nia");
    const { device } = await paired(who);
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "Where?", assigneeId: who.id });
    await updateIssue(who, issue.ref, { delegate: slug });
    const items = async () => (await getDb()).select().from(schema.notifications).where(and(eq(schema.notifications.recipientUserId, who.id), eq(schema.notifications.type, "run.needs_setup"), eq(schema.notifications.subjectId, issue.id)));
    assert.deepEqual(await jobsOf(issue.id), []);
    assert.equal((await items()).length, 1);
    assert.equal(await app.get(DelegationService).offerWaiting(), 0, "needs setup is not retried");
    assert.equal((await items()).length, 1, "and not announced again");
    await updateIssue(who, issue.ref, { targets: [{ repository: "acme/app" }] });
    assert.equal(await app.get(DelegationService).offerWaiting(), 1);
    assert.equal((await jobsOf(issue.id)).length, 1);
  });

  test("an issue with two targets starts one run per target", async () => {
    const { who, slug } = await setup("tom");
    const { device } = await paired(who);
    await online(device);
    const db = await getDb();
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.key, "DM"));
    const [second] = await db.insert(schema.repositories).values({ teamId: team.id, workspaceId: owner.workspaceId, displayName: "second", role: "x", provider: "github", slug: "second", githubRepoId: "555", githubInstallationId: "77", githubFullName: "acme/second", defaultBranch: "main" }).returning();
    const issue = await createIssue(owner, "DM", { title: "Two repos", assigneeId: who.id, targets: [{ repository: "acme/app" }, { repository: "acme/second" }] });
    await updateIssue(who, issue.ref, { delegate: slug });
    const jobs = await jobsOf(issue.id);
    assert.deepEqual(jobs.map((j) => j.repositoryId).sort(), [repoId, second.id].sort());
    assert.equal(new Set(jobs.map((j) => j.branch)).size, 2, "a branch each");
  });

  test("the issue shows where the delegation stands", async () => {
    const { who, slug } = await setup("sid");
    const { device } = await paired(who);
    const issue = await createIssue(owner, "DM", { title: "Stand", assigneeId: who.id });
    const state = async () => (await app.get(IssuesService).getIssue(who, issue.ref)).issue.delegation?.state ?? null;
    assert.equal(await state(), null);
    await updateIssue(who, issue.ref, { delegate: slug });
    assert.equal(await state(), "needs_setup");
    await updateIssue(who, issue.ref, { targets: [{ repository: "acme/app" }] });
    assert.equal(await state(), "waiting");
    await online(device);
    await app.get(DelegationService).offerWaiting();
    assert.equal(await state(), "running");
    const [job] = await jobsOf(issue.id);
    await d.acceptJob(device, job.id);
    await d.recordJobEvents(device, job.id, { events: [{ seq: 1, at: new Date().toISOString(), type: "tool", data: { name: "Edit" } }] });
    assert.equal((await app.get(IssuesService).getIssue(who, issue.ref)).issue.delegation?.line, "Using Edit");
    await d.finishJob(device, job.id, { state: "failed", error: "boom" });
    assert.equal(await state(), "failed");
  });

  test("the plan preview is what a start would do, and says what is missing", async () => {
    const { who, slug } = await setup("pat");
    const { device } = await paired(who);
    const issue = await createIssue(owner, "DM", { title: "Preview", assigneeId: who.id });
    const preview = () => runs.preview(who, issue.ref, slug);
    assert.deepEqual(await preview(), { missing: "needs_setup" });
    await updateIssue(who, issue.ref, { targets: [{ repository: "acme/app" }] });
    assert.deepEqual(await preview(), { missing: "waiting" });
    await online(device);
    const out = (await preview()) as { plans: { repository: string; baseBranch: string; device: string; model: string }[] };
    assert.deepEqual(out.plans.map((p) => [p.device, p.baseBranch]), [[device.name, "main"]]);
    assert.deepEqual(await jobsOf(issue.id), [], "a preview starts nothing");
    await assert.rejects(runs.preview(who, issue.ref, "nobody"), code("invalid"));
  });

  test("an agent's question is a comment and an inbox item; an answer on the issue carries the run on with it", async () => {
    const { who, slug, agent } = await setup("qin");
    const { device } = await paired(who);
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "Ask me", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    await updateIssue(who, issue.ref, { delegate: slug });
    const [job] = await jobsOf(issue.id);
    await d.acceptJob(device, job.id);
    await d.recordJobEvents(device, job.id, { events: [{ seq: 1, at: new Date().toISOString(), type: "result", data: { text: "QUESTION: which database?" } }] });
    await d.finishJob(device, job.id, { state: "succeeded" });

    const state = async () => (await app.get(IssuesService).getIssue(who, issue.ref)).issue.delegation?.state;
    assert.equal(await state(), "asked");
    const db = await getDb();
    const comments = async () => db.select().from(schema.comments).where(eq(schema.comments.issueId, issue.id));
    const [asked] = await comments();
    assert.equal(asked.authorKind, "agent");
    assert.match(asked.body, /has a question:\*\*\n\nwhich database\?/);
    const items = await db.select().from(schema.notifications).where(and(eq(schema.notifications.recipientUserId, who.id), eq(schema.notifications.subjectId, issue.id)));
    const questions = items.filter((n) => n.type.startsWith("run."));
    assert.deepEqual(questions.map((n) => n.type), ["run.question"]);
    assert.match(questions[0].title, / has a question on /);
    assert.equal((await jobsOf(issue.id)).length, 1, "no pull request, and nothing started until it is answered");
    assert.ok(agent);

    await app.get(IssuesService).addComment(who, issue.ref, "Postgres, please");
    const jobs = await jobsOf(issue.id);
    assert.equal(jobs.length, 2);
    const next = jobs.find((j) => j.id !== job.id)!;
    assert.equal(next.continuesJobId, job.id);
    assert.equal(next.branch, job.branch, "the same branch");
    const offers = await db.select().from(schema.deviceMessages).where(and(eq(schema.deviceMessages.deviceId, device.id), eq(schema.deviceMessages.type, "job.offer")));
    const sent = offers.map((o) => o.message as { jobId: string; previous: { answer?: string } | null }).find((m) => m.jobId === next.id)!;
    assert.equal(sent.previous?.answer, "Postgres, please");
    assert.equal(await state(), "running");
    await app.get(IssuesService).addComment(who, issue.ref, "and thanks");
    assert.equal((await jobsOf(issue.id)).length, 2, "only the answer carries it on");
  });

  test("only a team admin deletes a comment, and the audit names whose, not what", async () => {
    const { who, slug } = await setup("del");
    const issue = await createIssue(owner, "DM", { title: "Delete one", assigneeId: who.id });
    const c = await app.get(IssuesService).addComment(who, issue.ref, "oops, a secret");
    await assert.rejects(app.get(IssuesService).deleteComment(who, issue.ref, c.id), code("forbidden"));
    await app.get(IssuesService).deleteComment(owner, issue.ref, c.id);
    assert.deepEqual(await (await getDb()).select().from(schema.comments).where(eq(schema.comments.issueId, issue.id)), []);
    const [ev] = await (await getDb()).select().from(schema.events).where(and(eq(schema.events.entityId, issue.id), eq(schema.events.type, "comment.deleted")));
    assert.ok(!JSON.stringify(ev).includes("secret"));
    assert.ok(slug);
  });

  test("run defaults: the default device wins while online, model and effort fill what the agent leaves open, and an offline default falls back and says so", async () => {
    const { who, slug } = await setup("dee");
    const a = await paired(who);
    const b = await paired(who);
    await online(a.device);
    await online(b.device);
    const issue = await createIssue(owner, "DM", { title: "Defaults", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    assert.deepEqual(await devices.getRunDefaults(who), { deviceId: null, model: null, effort: null });
    await assert.rejects(devices.setRunDefaults(who, { deviceId: (await paired(owner)).device.id }), code("not_found"));
    await assert.rejects(devices.setRunDefaults(who, { effort: "max" }), code("invalid"));
    await devices.setRunDefaults(who, { deviceId: b.device.id, model: "opus", effort: "high" });
    type Plans = { plans: { device: string; model: string; effort: string | null; note?: string }[] };
    const plan = async () => ((await runs.preview(who, issue.ref, slug)) as Plans).plans[0];
    const first = await plan();
    assert.deepEqual([first.device, first.model, first.effort, first.note], [b.device.name, "opus", "high", undefined]);

    // Now b goes quiet: the run uses a, and the plan says its default was offline.
    await (await getDb()).update(schema.devices).set({ lastSeenAt: new Date(Date.now() - UNREACHABLE_AFTER_MS * 2) }).where(eq(schema.devices.id, b.device.id));
    const fell = await plan();
    assert.equal(fell.note, "your default device is offline");
    await updateIssue(who, issue.ref, { delegate: slug });
    const [job] = await jobsOf(issue.id);
    assert.equal(job.deviceId, a.device.id);
    assert.equal(job.model, "opus");
    assert.equal(job.effort, "high");
    await devices.setRunDefaults(who, { effort: null });
    assert.equal((await devices.getRunDefaults(who)).effort, null);
    assert.equal((await devices.getRunDefaults(who)).model, "opus", "only what is named changes");
  });

  test("a reviewer reads the issue's pull request, cannot push, opens no pull request, and leaves one review comment", async () => {
    const { who, slug } = await setup("rev", "reviewer");
    const { device } = await paired(who);
    await online(device);
    const db = await getDb();
    const issue = await createIssue(owner, "DM", { title: "Review me", assigneeId: who.id });
    await updateIssue(who, issue.ref, { delegate: slug });
    assert.deepEqual(await jobsOf(issue.id), [], "nothing to review yet, so it waits");
    assert.deepEqual(await runs.preview(who, issue.ref, slug), { missing: "waiting" });
    await assert.rejects(runs.runOnDevice(who, issue.ref, { deviceId: device.id, model: "opus", agent: slug }), code("conflict"));

    const [pr] = await db.insert(schema.pullRequests).values({ repositoryId: repoId, number: 77, title: "The change", url: "https://github.com/acme/app/pull/77", headBranch: "wh/feature", headSha: "abc1234" }).returning();
    await db.insert(schema.pullRequestIssues).values({ pullRequestId: pr.id, issueId: issue.id });
    assert.equal(await app.get(DelegationService).offerWaiting(), 1, "it starts once a pull request is linked");
    const [job] = await jobsOf(issue.id);
    assert.equal(job.mode, "review");
    assert.equal(job.branch, "wh/feature");
    const [offer] = await db.select().from(schema.deviceMessages).where(and(eq(schema.deviceMessages.deviceId, device.id), eq(schema.deviceMessages.type, "job.offer")));
    const sent = offer.message as { push: boolean; startFrom: string; review: { pullRequest: { number: number } } | null };
    assert.deepEqual([sent.push, sent.startFrom, sent.review?.pullRequest.number], [false, "wh/feature", 77]);

    await d.acceptJob(device, job.id);
    await d.recordJobEvents(device, job.id, { events: [{ seq: 1, at: new Date().toISOString(), type: "result", data: { text: "Changes needed: the button is not keyboard reachable" } }] });
    let opened = 0;
    await d.finishJob(device, job.id, { state: "succeeded", pushed: true, commit: "abcdef1", diffStats: { files: 2 } }, { api: { openPullRequest: async () => (opened++, { number: 1, url: "x" }) } });
    assert.equal(opened, 0);
    const rows = await db.select().from(schema.comments).where(eq(schema.comments.issueId, issue.id));
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /reviewed the pull request\.\*\*\n\nChanges needed/);
  });

  test("the issue suggests the roster agent its labels point at, until it is delegated", async () => {
    const { who, slug } = await setup("sug", "frontend");
    const issue = await createIssue(owner, "DM", { title: "Style it", assigneeId: who.id, labels: ["frontend"] });
    const suggested = async () => (await app.get(IssuesService).getIssue(who, issue.ref)).suggestedAgent;
    assert.equal(await suggested(), slug);
    await updateIssue(who, issue.ref, { delegate: slug });
    assert.equal(await suggested(), null);
  });

  test("learnings: a run proposes a few, they are capped and editable by people, and the agent's later runs carry them", async () => {
    const { who, slug } = await setup("lea");
    const { device } = await paired(who);
    await online(device);
    const learn = app.get(LearningsService);
    const issue = await createIssue(owner, "DM", { title: "Learn", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    await updateIssue(who, issue.ref, { delegate: slug });
    const [job] = await jobsOf(issue.id);
    await d.acceptJob(device, job.id);
    await d.finishJob(device, job.id, { state: "succeeded", learnings: ["This team keeps tests next to source", "  This team   keeps tests next to source ", "Use pnpm", "No semicolons", "a fourth is dropped"] });
    const { learnings } = await learn.list(who, "DM", slug);
    assert.deepEqual(learnings.map((l) => l.note), ["This team keeps tests next to source", "Use pnpm", "No semicolons"], "three a run, tidied, no repeats");

    await app.get(IssuesService).rerunDelegate(who, issue.ref);
    const next = (await jobsOf(issue.id)).find((j) => j.id !== job.id)!;
    const offers = await (await getDb()).select().from(schema.deviceMessages).where(and(eq(schema.deviceMessages.deviceId, device.id), eq(schema.deviceMessages.type, "job.offer")));
    const sent = offers.map((o) => o.message as { jobId: string; agent: { definitions: Record<string, { prompt: string }>; name: string } }).find((m) => m.jobId === next.id)!;
    assert.match(sent.agent.definitions[sent.agent.name].prompt, /What this team has taught you\n\n- This team keeps tests next to source\n- Use pnpm/);

    await learn.update(who, "DM", slug, learnings[1].id, "Use pnpm, never npm");
    await learn.remove(who, "DM", slug, learnings[2].id);
    assert.deepEqual((await learn.list(who, "DM", slug)).learnings.map((l) => l.note), ["This team keeps tests next to source", "Use pnpm, never npm"]);
    await assert.rejects(learn.update(who, "DM", slug, learnings[1].id, "  "), code("invalid"));
    await assert.rejects(learn.list(viewer, "DM", "nobody"), code("not_found"));

    const many = Array.from({ length: 30 }, (_, i) => `note ${i}`);
    for (let n = 0; n < 10; n++) await (await getDb()).insert(schema.agentLearnings).values({ teamId: job.teamId, workspaceId: job.workspaceId, agentId: job.agentId!, note: `filler ${n}` });
    await app.get(DaemonRepository).addLearnings({ id: job.teamId, workspaceId: job.workspaceId }, job.agentId!, many, 20);
    assert.equal((await learn.list(who, "DM", slug)).learnings.length, 20, "capped at 20");
  });

  test("a parent's run is offered its open sub-issues in order, and owns them: a sub-issue cannot be delegated meanwhile", async () => {
    const { who, slug } = await setup("par");
    const { device } = await paired(who);
    await online(device);
    const db = await getDb();
    const parent = await createIssue(owner, "DM", { title: "Parent", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    const one = await createIssue(owner, "DM", { title: "First part", body: "do the first thing", parent: parent.ref });
    const two = await createIssue(owner, "DM", { title: "Second part", parent: parent.ref });
    await updateIssue(owner, two.ref, { assigneeId: who.id });
    await app.get(IssuesService).moveIssue(owner, one.ref, "Done");
    const three = await createIssue(owner, "DM", { title: "Third part", parent: parent.ref, assigneeId: who.id });
    await updateIssue(who, parent.ref, { delegate: slug });
    const [job] = await jobsOf(parent.id);
    const [offer] = await db.select().from(schema.deviceMessages).where(and(eq(schema.deviceMessages.deviceId, device.id), eq(schema.deviceMessages.type, "job.offer")));
    const subs = (offer.message as { issue: { subIssues: { ref: string; title: string }[] } }).issue.subIssues;
    assert.deepEqual(subs.map((x) => x.ref), [two.ref, three.ref], "the finished one is left out, the rest are in order");
    assert.equal(job.state, "offered");
    await assert.rejects(updateIssue(who, three.ref, { delegate: slug }), code("conflict"));
    await updateIssue(who, parent.ref, { delegate: null });
    await updateIssue(who, three.ref, { delegate: slug });
  });

  test("every run leaves one summary comment as the agent", async () => {
    const { who, slug } = await setup("sum");
    const { device } = await paired(who);
    await online(device);
    const issue = await createIssue(owner, "DM", { title: "Summarise", assigneeId: who.id, targets: [{ repository: "acme/app" }] });
    await updateIssue(who, issue.ref, { delegate: slug });
    const [job] = await jobsOf(issue.id);
    await d.acceptJob(device, job.id);
    await d.recordJobEvents(device, job.id, { events: [{ seq: 1, at: new Date().toISOString(), type: "result", data: { text: "Added the button" } }] });
    await d.finishJob(device, job.id, { state: "succeeded" });
    await d.finishJob(device, job.id, { state: "succeeded" });
    const rows = await (await getDb()).select().from(schema.comments).where(eq(schema.comments.issueId, issue.id));
    assert.equal(rows.length, 1, "a finish sent again adds nothing");
    assert.equal(rows[0].authorKind, "agent");
    assert.match(rows[0].body, /finished\.\*\*\n\nAdded the button/);
  });
});
