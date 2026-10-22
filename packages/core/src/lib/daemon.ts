import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { DeviceJobState } from "../db/schema";
import { sha256, type Actor } from "./access";
import { randomToken } from "./auth-core";
import { GithubApiError, type GithubApi } from "./github/api";
import { github } from "./github/runtime";
import { assertionSubject, publicKeyFromRaw, rawPublicKey, serverSigningKey, signValue, verifyAssertion } from "./daemon-crypto";
import { bus } from "./event-bus";
import { rateLimit } from "./rate-limit";
import { resolveIssue, ServiceError, type Q } from "./service";
import { isUuid, workspaceRoleOf } from "./team-access";

/**
 * The agent daemon's side of Wheelhouse (see wheelhouse-cli/daemon/DESIGN.md): pairing a machine, its short-lived tokens, the signed
 * messages its stream carries, and jobs ("Run on device") from offer to finish. The daemon dials out: it reads its messages over SSE
 * and POSTs everything it reports. People reach the same data through the web app's functions at the end of this file.
 */

const { devices, devicePairings, deviceTokens, deviceMessages, deviceJobs, deviceJobEvents, issues, repositories, teams } = schema;

export const PAIRING_TTL_MS = 10 * 60_000;
/** How often the daemon may poll a pairing; faster polls are told to slow down (RFC 8628). */
export const PAIRING_POLL_INTERVAL_S = 5;
export const TOKEN_TTL_S = 15 * 60;
/** An offer the device has not accepted by then is expired. */
export const OFFER_TTL_MS = 60_000;
/** A device that has not been heard from for this long is offline: no new offers. */
export const ONLINE_WINDOW_MS = 90_000;
/** A job whose device has been silent this long is lost. */
export const LOST_AFTER_MS = 3 * 60_000;
export const MAX_POOL_SIZE = 8;
export const MAX_EVENTS_PER_JOB = 5_000;
export const MAX_EVENTS_PER_BATCH = 200;
/** The models a job may ask for when the device has not listed its own (aliases the claude CLI understands). */
export const DEFAULT_MODELS = ["opus", "sonnet", "haiku"];

const ACTIVE: DeviceJobState[] = ["offered", "accepted", "running"];
const FINAL: DeviceJobState[] = ["succeeded", "failed", "canceled", "rejected", "expired", "lost"];
export const isFinalState = (s: DeviceJobState) => FINAL.includes(s);

export type Device = typeof devices.$inferSelect;

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ───────── a device's stream: who is listening ─────────

type Listener = () => void;
const g = globalThis as unknown as { __whDeviceListeners?: Map<string, Set<Listener>> };
const listeners = (g.__whDeviceListeners ??= new Map());

function listen(deviceId: string, fn: Listener) {
  let set = listeners.get(deviceId);
  if (!set) listeners.set(deviceId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(deviceId);
  };
}
/** Tell the device's open stream that new messages are in the log. Call it after the write has committed. */
function wake(deviceId: string) {
  for (const fn of [...(listeners.get(deviceId) ?? [])]) fn();
}

/** A job changed: tell the browsers watching its team, so the issue's run list refreshes (a transient signal, not in the log). */
const lastSignal = new Map<string, number>();
function signalJob(job: { id: string; workspaceId: string; teamId: string; issueId: string }, throttleMs = 0) {
  const now = Date.now();
  if (throttleMs && now - (lastSignal.get(job.id) ?? 0) < throttleMs) return;
  lastSignal.set(job.id, now);
  if (lastSignal.size > 5_000) lastSignal.clear();
  bus.publish({ workspaceId: job.workspaceId, teamId: job.teamId, type: "job.updated", entity: "issue", entityId: job.issueId });
}

// ───────── signed messages to a device ─────────

type MessageType = (typeof schema.DEVICE_MESSAGE_TYPES)[number];
type SigningKey = Awaited<ReturnType<typeof serverSigningKey>>;

/**
 * Append a signed message to the device's log. The signature covers the whole `message`, which names the device and the time, so a
 * message cannot be replayed to another machine. The caller loads `key` before opening its transaction: loading it the first time reads
 * the database, which inside a transaction on the single-connection embedded database would wait for itself forever.
 */
async function sendToDevice(q: Q, key: SigningKey, deviceId: string, type: MessageType, body: Record<string, unknown>) {
  const { privateKey } = key;
  const message = { ...body, type, deviceId, issuedAt: new Date().toISOString() };
  await q.insert(deviceMessages).values({ deviceId, type, message, signature: signValue(privateKey, message) });
  return deviceId;
}

const formatMessage = (m: typeof deviceMessages.$inferSelect) => `id: ${m.seq}\nevent: ${m.type}\ndata: ${JSON.stringify({ message: m.message, signature: m.signature })}\n\n`;

export const DEVICE_STREAM_HEARTBEAT_MS = 25_000;
const DEVICE_STREAM_RECHECK_MS = 15_000;
const REPLAY_LIMIT = 500;

/**
 * The device's stream: every message after `since` (its Last-Event-ID; null is the start of its log), then new ones as they are
 * written. It ends when the device is revoked or `signal` aborts. Messages are read from the table, never from memory, so a message
 * written while the stream was down is sent on reconnect.
 */
export function deviceStream(deviceId: string, since: number | null, signal: AbortSignal, opts: { heartbeatMs?: number; recheckMs?: number } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let last = since ?? 0;
  let closed = false;
  let pumping = false;
  let again = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  let unlisten: (() => void) | null = null;
  let ctl: ReadableStreamDefaultController<Uint8Array>;

  const close = () => {
    if (closed) return;
    closed = true;
    unlisten?.();
    timers.forEach(clearInterval);
    signal.removeEventListener("abort", close);
    try {
      ctl.close();
    } catch {
      /* the client already went away */
    }
  };
  const send = (text: string) => {
    if (closed) return;
    try {
      ctl.enqueue(enc.encode(text));
    } catch {
      close();
    }
  };
  // Send whatever is new. Wakes that arrive while a read is running are folded into one more read.
  const pump = async () => {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        const db = await getDb();
        const rows = await db.select().from(deviceMessages).where(and(eq(deviceMessages.deviceId, deviceId), gt(deviceMessages.seq, last))).orderBy(asc(deviceMessages.seq)).limit(REPLAY_LIMIT);
        for (const r of rows) {
          send(formatMessage(r));
          last = r.seq;
        }
        if (rows.length === REPLAY_LIMIT) again = true;
      } while (again && !closed);
    } catch {
      /* the database hiccuped: the next wake or heartbeat tries again */
    } finally {
      pumping = false;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      ctl = controller;
      if (signal.aborted) return close();
      signal.addEventListener("abort", close);
      send("retry: 5000\n\n");
      unlisten = listen(deviceId, () => void pump());
      timers.push(setInterval(() => {
        send(": keep-alive\n\n");
        void pump(); // also catches a message written by another process
      }, opts.heartbeatMs ?? DEVICE_STREAM_HEARTBEAT_MS));
      timers.push(setInterval(async () => {
        try {
          const db = await getDb();
          const [d] = await db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, deviceId));
          if (!d || d.revokedAt) close();
        } catch {
          /* keep the stream; the next check tries again */
        }
      }, opts.recheckMs ?? DEVICE_STREAM_RECHECK_MS));
      void pump();
    },
    cancel() {
      close();
    },
  });
}

/** The position a device resumes from: its Last-Event-ID header. */
export function parseLastEventId(v: string | null | undefined): number | null {
  return v != null && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : null;
}

// ───────── pairing (RFC 8628) ─────────

// No vowels or look-alikes, so a code is easy to read aloud and never spells a word.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
function userCode() {
  const pick = () => Array.from(crypto.randomBytes(4), (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join("");
  return `${pick()}-${pick()}`;
}
const normalizeUserCode = (v: unknown) => {
  const s = str(v, 20).toUpperCase().replace(/[^A-Z]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
};

export const PAIRING_STARTS_PER_IP = 20;

/**
 * Step 1, from the daemon: `{ publicKey, name, os }`. Answers the device code (the daemon's secret for polling), the code the person
 * types in Wheelhouse, and where to type it. Nothing is created until a signed-in person approves.
 */
export async function startPairing(input: Record<string, unknown>, ctx: { ip: string; origin: string }) {
  const limited = rateLimit(`pair-start:${ctx.ip}`, PAIRING_STARTS_PER_IP, 60 * 60_000);
  if (!limited.ok) throw new ServiceError("forbidden", "Too many pairing attempts from this address; try again later");
  const key = publicKeyFromRaw(input.publicKey);
  if (!key) throw new ServiceError("invalid", "publicKey must be a raw Ed25519 public key in base64url", { fields: { publicKey: "Ed25519, base64url" } });
  const name = str(input.name, 80);
  const os = str(input.os, 40);
  if (!name) throw new ServiceError("invalid", "name is required", { fields: { name: "required" } });
  if (!os) throw new ServiceError("invalid", "os is required", { fields: { os: "required" } });
  const db = await getDb();
  await db.delete(devicePairings).where(lt(devicePairings.expiresAt, new Date(Date.now() - PAIRING_TTL_MS)));
  const deviceCode = randomToken();
  const code = userCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await db.insert(devicePairings).values({ deviceCodeHash: sha256(deviceCode), userCode: code, publicKey: rawPublicKey(key), name, os, expiresAt });
  const verificationUri = `${ctx.origin}/devices/pair`;
  return {
    deviceCode,
    userCode: code,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(code)}`,
    expiresIn: Math.round(PAIRING_TTL_MS / 1000),
    interval: PAIRING_POLL_INTERVAL_S,
  };
}

export type PollResult =
  | { status: "pending" | "slow_down" | "denied" | "expired" }
  | { status: "approved"; deviceId: string; serverPublicKey: string; workspace: { id: string; name: string }; device: { name: string; poolSize: number } };

/**
 * Step 3, from the daemon: `{ deviceCode }`, every `interval` seconds until it is approved, denied or expired. The approved answer is
 * given once (the pairing is then consumed) and carries the server's public key, which the daemon pins.
 */
export async function pollPairing(input: Record<string, unknown>, now = new Date()): Promise<PollResult> {
  const deviceCode = str(input.deviceCode, 200);
  if (!deviceCode) throw new ServiceError("invalid", "deviceCode is required");
  const db = await getDb();
  const [p] = await db.select().from(devicePairings).where(eq(devicePairings.deviceCodeHash, sha256(deviceCode)));
  if (!p || p.state === "consumed" || p.expiresAt < now) return { status: "expired" };
  if (p.state === "denied") return { status: "denied" };
  if (p.state === "pending") {
    const tooSoon = p.lastPolledAt && now.getTime() - p.lastPolledAt.getTime() < (PAIRING_POLL_INTERVAL_S - 1) * 1000;
    await db.update(devicePairings).set({ lastPolledAt: now }).where(eq(devicePairings.id, p.id));
    return { status: tooSoon ? "slow_down" : "pending" };
  }
  // Approved: hand over once.
  const [claimed] = await db
    .update(devicePairings)
    .set({ state: "consumed" })
    .where(and(eq(devicePairings.id, p.id), eq(devicePairings.state, "approved")))
    .returning();
  if (!claimed?.deviceId) return { status: "expired" };
  const [row] = await db
    .select({ device: devices, workspace: schema.workspaces })
    .from(devices)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, devices.workspaceId))
    .where(eq(devices.id, claimed.deviceId));
  if (!row) return { status: "expired" };
  const { publicKey } = await serverSigningKey();
  return {
    status: "approved",
    deviceId: row.device.id,
    serverPublicKey: rawPublicKey(publicKey),
    workspace: { id: row.workspace.id, name: row.workspace.name },
    device: { name: row.device.name, poolSize: row.device.poolSize },
  };
}

async function pendingPairing(code: unknown) {
  const c = normalizeUserCode(code);
  if (!c) throw new ServiceError("not_found", "That code is not valid. Check it on the machine and try again.");
  const db = await getDb();
  const [p] = await db.select().from(devicePairings).where(eq(devicePairings.userCode, c));
  if (!p || p.state !== "pending" || p.expiresAt < new Date()) throw new ServiceError("not_found", "That code is not valid or has expired. Start pairing again on the machine.");
  return p;
}

/** Only people who can work in the workspace pair machines: a viewer or guest cannot run agents. */
async function requirePairer(actor: Actor) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can pair a machine");
  const role = await workspaceRoleOf(await getDb(), actor.workspaceId, actor.id);
  if (!role || role === "viewer" || role === "guest") throw new ServiceError("forbidden", "Your workspace role cannot run agents on a machine");
}

/** What the approval page shows before the person says yes: the machine as it described itself. */
export async function peekPairing(actor: Actor, code: unknown) {
  await requirePairer(actor);
  const p = await pendingPairing(code);
  return { userCode: p.userCode, name: p.name, os: p.os, expiresAt: p.expiresAt.toISOString() };
}

/** Step 2, the person: approve the machine into their workspace, optionally renaming it. The device row is created here. */
export async function approvePairing(actor: Actor, code: unknown, input: { name?: unknown } = {}) {
  await requirePairer(actor);
  const p = await pendingPairing(code);
  const name = str(input.name, 80) || p.name;
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(devicePairings)
      .set({ state: "approved" })
      .where(and(eq(devicePairings.id, p.id), eq(devicePairings.state, "pending")))
      .returning();
    if (!claimed) throw new ServiceError("conflict", "This code was just used");
    const [existing] = await tx.select().from(devices).where(eq(devices.publicKey, p.publicKey));
    if (existing) throw new ServiceError("conflict", "This machine's key is already paired; unpair it first");
    const [d] = await tx.insert(devices).values({ workspaceId: actor.workspaceId, ownerId: actor.id, name, os: p.os, publicKey: p.publicKey }).returning();
    await tx.update(devicePairings).set({ deviceId: d.id }).where(eq(devicePairings.id, p.id));
    return { device: deviceView(d) };
  });
}

export async function denyPairing(actor: Actor, code: unknown) {
  await requirePairer(actor);
  const p = await pendingPairing(code);
  const db = await getDb();
  await db.update(devicePairings).set({ state: "denied" }).where(and(eq(devicePairings.id, p.id), eq(devicePairings.state, "pending")));
  return { ok: true as const };
}

// ───────── tokens ─────────

export class DeviceAuthError extends Error {
  status = 401;
}

/**
 * `{ assertion }`: an EdDSA JWT the device signed with its own key (`sub` its id, `aud` wheelhouse:daemon-token, a fresh `jti`, a few
 * minutes' life). Answers a 15-minute access token. Each assertion works once. Every failure reads the same.
 */
export async function exchangeAssertion(input: Record<string, unknown>, ctx: { ip: string }) {
  const fail = () => {
    const r = rateLimit(`device-token-fail:${ctx.ip}`, 30, 60_000);
    if (!r.ok) throw new ServiceError("forbidden", "Too many failed attempts; try again later");
    return new DeviceAuthError("Invalid assertion");
  };
  const jwt = str(input.assertion, 4000);
  const sub = assertionSubject(jwt);
  if (!sub || !isUuid(sub)) throw fail();
  const db = await getDb();
  const [row] = await db
    .select({ device: devices, suspendedAt: schema.workspaces.suspendedAt })
    .from(devices)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, devices.workspaceId))
    .where(eq(devices.id, sub));
  const key = row ? publicKeyFromRaw(row.device.publicKey) : null;
  const claims = key ? verifyAssertion(jwt, key) : null;
  if (!row || !claims || row.device.revokedAt) throw fail();
  if (row.suspendedAt) throw new ServiceError("forbidden", "This workspace has been suspended");
  const token = `whd_${randomToken()}`;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_S * 1000);
  await db.delete(deviceTokens).where(and(eq(deviceTokens.deviceId, row.device.id), lt(deviceTokens.expiresAt, new Date())));
  const inserted = await db.insert(deviceTokens).values({ tokenHash: sha256(token), deviceId: row.device.id, jti: claims.jti, expiresAt }).onConflictDoNothing().returning();
  if (!inserted.length) throw fail(); // the assertion was used before
  return { accessToken: token, tokenType: "Bearer", expiresIn: TOKEN_TTL_S };
}

/** The device behind `Authorization: Bearer whd_...`. Revoked devices, expired tokens and suspended workspaces are refused. */
export async function deviceForToken(authorization: string | null | undefined, now = new Date()): Promise<Device> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token.startsWith("whd_")) throw new DeviceAuthError("Missing device token");
  const db = await getDb();
  const [row] = await db
    .select({ device: devices, suspendedAt: schema.workspaces.suspendedAt })
    .from(deviceTokens)
    .innerJoin(devices, eq(devices.id, deviceTokens.deviceId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, devices.workspaceId))
    .where(and(eq(deviceTokens.tokenHash, sha256(token)), gt(deviceTokens.expiresAt, now)));
  if (!row || row.device.revokedAt) throw new DeviceAuthError("Invalid or expired device token");
  if (row.suspendedAt) throw new ServiceError("forbidden", "This workspace has been suspended");
  const used = rateLimit(`device:${row.device.id}`, 1200, 60_000);
  if (!used.ok) throw new ServiceError("forbidden", "Too many requests from this device");
  return row.device;
}

// ───────── what the daemon reports ─────────

/** Keep only what Wheelhouse uses from a capability report, with bounded sizes; anything else the daemon sends is dropped. */
export function cleanCapabilities(v: unknown): Record<string, unknown> {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const c = (o.claude && typeof o.claude === "object" ? o.claude : {}) as Record<string, unknown>;
  const repos = Array.isArray(o.repositories) ? o.repositories : [];
  const power = (o.power && typeof o.power === "object" ? o.power : {}) as Record<string, unknown>;
  return {
    claude: {
      installed: c.installed === true,
      version: str(c.version, 40) || null,
      signedIn: c.signedIn === true,
      subscriptionType: str(c.subscriptionType, 40) || null,
      models: Array.isArray(c.models) ? c.models.map((m) => str(m, 60)).filter(Boolean).slice(0, 20) : [],
    },
    repositories: repos
      .slice(0, 200)
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
      .filter((r) => isUuid(r.repositoryId))
      .map((r) => ({ repositoryId: r.repositoryId as string, source: r.source === "link" ? "link" : "clone" })),
    platform: str(o.platform, 40) || null,
    power: { onBattery: power.onBattery === true },
  };
}

/**
 * `{ version, capabilities, jobs: [{ id, state }] }`, sent each time the daemon connects. Records what the machine can do now, and
 * reconciles: a job this device was running that the daemon no longer knows about (it restarted and lost it) is lost.
 */
export async function deviceHello(device: Device, input: Record<string, unknown>) {
  const db = await getDb();
  const reported = new Set(
    (Array.isArray(input.jobs) ? input.jobs : [])
      .map((j) => (j && typeof j === "object" ? (j as Record<string, unknown>).id : null))
      .filter(isUuid),
  );
  const [d] = await db
    .update(devices)
    .set({ daemonVersion: str(input.version, 40) || null, capabilities: cleanCapabilities(input.capabilities), lastSeenAt: new Date() })
    .where(eq(devices.id, device.id))
    .returning();
  const running = await db.select().from(deviceJobs).where(and(eq(deviceJobs.deviceId, device.id), inArray(deviceJobs.state, ["accepted", "running"])));
  for (const j of running.filter((j) => !reported.has(j.id))) {
    await finishJobRow(j, "lost", { error: "The daemon restarted and no longer has this job" });
  }
  return { device: { id: d.id, name: d.name, poolSize: d.poolSize, chatModel: d.chatModel } };
}

/** `{ running: [jobId], free, onBattery }`, every 30 seconds. Keeps the device online and its jobs from being declared lost. */
export async function deviceHeartbeat(device: Device, input: Record<string, unknown>) {
  const db = await getDb();
  const caps = { ...(device.capabilities ?? {}), power: { onBattery: input.onBattery === true }, pool: { free: Number.isInteger(input.free) ? input.free : null } };
  await db.update(devices).set({ lastSeenAt: new Date(), capabilities: caps }).where(eq(devices.id, device.id));
  return { ok: true as const };
}

async function deviceJob(device: Device, jobId: string) {
  if (!isUuid(jobId)) throw new ServiceError("not_found", "No such job");
  const db = await getDb();
  const [j] = await db.select().from(deviceJobs).where(and(eq(deviceJobs.id, jobId), eq(deviceJobs.deviceId, device.id)));
  if (!j) throw new ServiceError("not_found", "No such job");
  return j;
}

/** Move a job to `to` only if it is still in one of `from`; false when something else got there first. */
async function transition(jobId: string, from: DeviceJobState[], set: Partial<typeof deviceJobs.$inferInsert> & { state: DeviceJobState }) {
  const db = await getDb();
  const [row] = await db
    .update(deviceJobs)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(deviceJobs.id, jobId), inArray(deviceJobs.state, from)))
    .returning();
  if (row) signalJob(row);
  return row ?? null;
}

async function finishJobRow(j: typeof deviceJobs.$inferSelect, state: DeviceJobState, extra: { error?: string | null; result?: Record<string, unknown> } = {}) {
  return transition(j.id, ACTIVE, { state, finishedAt: new Date(), error: extra.error ?? null, ...(extra.result ? { result: extra.result } : {}) });
}

/** The daemon takes the job: it has a free slot and the repository. Too late (expired, canceled) is a conflict. */
export async function acceptJob(device: Device, jobId: string) {
  const j = await deviceJob(device, jobId);
  if (j.state === "offered" && j.offerExpiresAt < new Date()) {
    await transition(j.id, ["offered"], { state: "expired", finishedAt: new Date() });
    throw new ServiceError("conflict", "The offer expired");
  }
  if (j.cancelRequestedAt) throw new ServiceError("conflict", "The job was canceled");
  const row = await transition(j.id, ["offered"], { state: "accepted", acceptedAt: new Date() });
  if (!row) throw new ServiceError("conflict", `The job is ${j.state}`);
  return { job: { id: row.id, state: row.state } };
}

export const REJECT_REASONS = ["no_free_slot", "unknown_repository", "bad_signature", "expired", "unsupported_model", "not_ready"] as const;

export async function rejectJob(device: Device, jobId: string, input: Record<string, unknown>) {
  const j = await deviceJob(device, jobId);
  const reason = (REJECT_REASONS as readonly string[]).includes(input.reason as string) ? (input.reason as string) : "not_ready";
  const detail = str(input.detail, 500);
  const row = await transition(j.id, ["offered"], { state: "rejected", finishedAt: new Date(), error: detail ? `${reason}: ${detail}` : reason });
  if (!row) throw new ServiceError("conflict", `The job is ${j.state}`);
  return { job: { id: row.id, state: row.state } };
}

/**
 * `{ events: [{ seq, at, type, data }] }`: a batch of progress. `seq` is the daemon's own number for the event, so a batch sent again
 * after a dropped connection is stored once. A `started` event moves an accepted job to running.
 */
export async function recordJobEvents(device: Device, jobId: string, input: Record<string, unknown>) {
  const j = await deviceJob(device, jobId);
  if (isFinalState(j.state)) throw new ServiceError("conflict", `The job is ${j.state}`);
  const list = Array.isArray(input.events) ? input.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
  const rows = list
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
    .filter((e) => Number.isInteger(e.seq) && (e.seq as number) >= 0 && (e.seq as number) < MAX_EVENTS_PER_JOB && str(e.type, 60))
    .map((e) => {
      const at = new Date(typeof e.at === "string" ? e.at : NaN);
      const data = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {};
      // One event's data is a summary, not a transcript: oversized payloads are cut to a note.
      const small = JSON.stringify(data).length <= 8_000 ? data : { truncated: true };
      return { jobId: j.id, seq: e.seq as number, at: Number.isNaN(at.getTime()) ? new Date() : at, type: str(e.type, 60), data: small };
    });
  const db = await getDb();
  if (rows.length) await db.insert(deviceJobEvents).values(rows).onConflictDoNothing();
  if (j.state === "accepted" && rows.some((r) => r.type === "started")) await transition(j.id, ["accepted"], { state: "running", startedAt: new Date() });
  else signalJob(j, 2_000);
  return { stored: rows.length };
}

type PullRequestOpener = { api: Pick<GithubApi, "openPullRequest"> } | null;

/**
 * `{ state: succeeded | failed | canceled, branch?, commit?, diffStats?, costUsd?, error? }`: the daemon is done with the job. A
 * succeeded job that pushed changes gets a pull request, opened by the GitHub App (see `openJobPullRequest`).
 */
export async function finishJob(device: Device, jobId: string, input: Record<string, unknown>, gh: PullRequestOpener = github()) {
  const j = await deviceJob(device, jobId);
  const state = input.state as DeviceJobState;
  if (!["succeeded", "failed", "canceled"].includes(state)) throw new ServiceError("invalid", "state must be succeeded, failed or canceled");
  const stats = (input.diffStats && typeof input.diffStats === "object" ? input.diffStats : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const result = {
    commit: /^[0-9a-f]{7,40}$/.test(str(input.commit, 40)) ? str(input.commit, 40) : null,
    pushed: input.pushed === true,
    diffStats: { files: num(stats.files), insertions: num(stats.insertions), deletions: num(stats.deletions) },
    costUsd: num(input.costUsd),
    durationMs: num(input.durationMs),
  };
  const row = await finishJobRow(j, state, { error: state === "succeeded" ? null : str(input.error, 2000) || null, result });
  if (!row) {
    if (j.state === state) return { job: { id: j.id, state: j.state } }; // the same finish, sent again
    throw new ServiceError("conflict", `The job is ${j.state}`);
  }
  // Only the finish that moved the job opens one, so a finish sent again never opens a second.
  if (state === "succeeded" && result.pushed && result.commit && result.diffStats.files !== 0) await openJobPullRequest(row, device, gh);
  return { job: { id: row.id, state: row.state } };
}

/**
 * The run's pull request, from its branch into the branch it started from. It is opened ready for review, not as a draft, so the
 * pull request rules move the issue to Review. A refusal is recorded on the run (`result.pullRequestError`), and a repository the App cannot reach as a note (`pullRequestSkipped`); neither fails the
 * finish: the branch is pushed either way, and a person can open the pull request by hand.
 */
async function openJobPullRequest(j: typeof deviceJobs.$inferSelect, device: Device, gh: PullRequestOpener) {
  const db = await getDb();
  const [row] = await db
    .select({ issue: issues, teamKey: teams.key, repo: repositories })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .innerJoin(repositories, eq(repositories.id, j.repositoryId!))
    .where(eq(issues.id, j.issueId));
  let outcome: Record<string, unknown>;
  if (!row) return;
  // A continuation pushes to a branch that may already have its pull request: the push updated it, so it is this run's too.
  const [earlier] = await db
    .select({ result: deviceJobs.result })
    .from(deviceJobs)
    .where(and(eq(deviceJobs.branch, j.branch), eq(deviceJobs.repositoryId, j.repositoryId!), sql`${deviceJobs.id} <> ${j.id}`, sql`${deviceJobs.result} ? 'pullRequest'`))
    .orderBy(desc(deviceJobs.createdAt))
    .limit(1);
  if (earlier) {
    const [updated] = await db
      .update(deviceJobs)
      .set({ result: sql`${deviceJobs.result} || ${JSON.stringify({ pullRequest: earlier.result.pullRequest })}::jsonb`, updatedAt: new Date() })
      .where(eq(deviceJobs.id, j.id))
      .returning();
    if (updated) signalJob(updated);
    return;
  }
  // Not an error: without the App no pull request was ever expected, so the run just reads as pushed.
  if (!gh || !row.repo.githubInstallationId || !row.repo.githubRepoId)
    outcome = { pullRequestSkipped: "The GitHub App is not set up for this repository, so no pull request was opened" };
  else {
    const ref = `${row.teamKey}-${row.issue.number}`;
    const r = j.result as { costUsd?: number | null; diffStats?: { files: number | null; insertions: number | null; deletions: number | null } };
    const stats = r.diffStats?.files != null ? `${r.diffStats.files} files, +${r.diffStats.insertions ?? 0} −${r.diffStats.deletions ?? 0}` : null;
    const body = [
      `Agent run for ${ref}: ${row.issue.title}`,
      "",
      [`Run on ${device.name} with ${j.model}`, stats, r.costUsd != null ? `~$${r.costUsd.toFixed(2)}` : null].filter(Boolean).join(" · "),
      "",
      "Opened by the Wheelhouse daemon. An agent wrote these commits; review them before merging.",
    ].join("\n");
    try {
      const pr = await gh.api.openPullRequest(row.repo.githubInstallationId, row.repo.githubRepoId, {
        title: `${ref}: ${row.issue.title}`,
        head: j.branch,
        base: j.baseBranch || row.repo.defaultBranch || "main",
        body,
      });
      outcome = { pullRequest: pr };
    } catch (e) {
      const status = e instanceof GithubApiError ? e.status : null;
      outcome = {
        pullRequestError:
          status === 403
            ? "GitHub refused: the App needs the \"Pull requests: Read and write\" permission"
            : status === 422
              ? "GitHub refused: the branch has no changes against its base, or a pull request for it is already open"
              : `Could not open the pull request (${e instanceof Error ? e.message : "unknown error"})`,
      };
    }
  }
  const [updated] = await db
    .update(deviceJobs)
    .set({ result: sql`${deviceJobs.result} || ${JSON.stringify(outcome)}::jsonb`, updatedAt: new Date() })
    .where(eq(deviceJobs.id, j.id))
    .returning();
  if (updated) signalJob(updated);
}

/**
 * Time-based moves, run every so often by the host: offers nobody accepted expire, and jobs on a device that went silent are lost (its
 * branch, if it pushed one, stays). Returns how many of each, for the log.
 */
export async function sweepDeviceJobs(now = new Date()) {
  const db = await getDb();
  const expired = await db
    .update(deviceJobs)
    .set({ state: "expired", finishedAt: now, updatedAt: now })
    .where(and(eq(deviceJobs.state, "offered"), lt(deviceJobs.offerExpiresAt, now)))
    .returning();
  const silent = db.select({ id: devices.id }).from(devices).where(or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, new Date(now.getTime() - LOST_AFTER_MS)), sql`${devices.revokedAt} is not null`));
  const lost = await db
    .update(deviceJobs)
    .set({ state: "lost", finishedAt: now, updatedAt: now, error: "The device stopped reporting" })
    .where(and(inArray(deviceJobs.state, ["accepted", "running"]), inArray(deviceJobs.deviceId, silent)))
    .returning();
  for (const j of [...expired, ...lost]) signalJob(j);
  return { expired: expired.length, lost: lost.length };
}

// ───────── people: devices ─────────

export const deviceOnline = (d: Pick<Device, "lastSeenAt" | "revokedAt">, now = Date.now()) => !d.revokedAt && !!d.lastSeenAt && now - d.lastSeenAt.getTime() < ONLINE_WINDOW_MS;

function deviceView(d: Device) {
  const caps = (d.capabilities ?? {}) as { claude?: { models?: string[] } };
  // A device that has reported lists exactly what it offers (none when claude is missing or signed out); the defaults are only for one
  // that has not said hello yet.
  return {
    id: d.id,
    name: d.name,
    os: d.os,
    status: d.revokedAt ? ("revoked" as const) : deviceOnline(d) ? ("online" as const) : ("offline" as const),
    poolSize: d.poolSize,
    chatModel: d.chatModel,
    daemonVersion: d.daemonVersion,
    capabilities: d.capabilities,
    models: caps.claude ? (caps.claude.models ?? []) : DEFAULT_MODELS,
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}
export type DeviceView = ReturnType<typeof deviceView>;

/** The person's own paired machines in this workspace, each with how many jobs it is running. */
export async function listDevices(actor: Actor) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person has devices");
  const db = await getDb();
  const rows = await db
    .select()
    .from(devices)
    .where(and(eq(devices.ownerId, actor.id), eq(devices.workspaceId, actor.workspaceId), isNull(devices.revokedAt)))
    .orderBy(asc(devices.createdAt));
  const busy = rows.length
    ? await db
        .select({ deviceId: deviceJobs.deviceId, n: sql<number>`count(*)::int` })
        .from(deviceJobs)
        .where(and(inArray(deviceJobs.deviceId, rows.map((r) => r.id)), inArray(deviceJobs.state, ACTIVE)))
        .groupBy(deviceJobs.deviceId)
    : [];
  const count = new Map(busy.map((b) => [b.deviceId, b.n]));
  return rows.map((d) => ({ ...deviceView(d), activeJobs: count.get(d.id) ?? 0 }));
}

async function ownDevice(actor: Actor, id: string, q?: Q) {
  if (actor.kind !== "human" || !isUuid(id)) throw new ServiceError("not_found", "Device not found");
  const db = q ?? (await getDb());
  const [d] = await db.select().from(devices).where(and(eq(devices.id, id), eq(devices.ownerId, actor.id), eq(devices.workspaceId, actor.workspaceId), isNull(devices.revokedAt)));
  if (!d) throw new ServiceError("not_found", "Device not found");
  return d;
}

/** `{ name?, poolSize?, chatModel? }`. A new pool size or chat model is sent to the daemon as a signed settings message. */
export async function updateDevice(actor: Actor, id: string, input: Record<string, unknown>) {
  const db = await getDb();
  const d = await ownDevice(actor, id, db);
  const patch: Partial<typeof devices.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = str(input.name, 80);
    if (!name) throw new ServiceError("invalid", "A device needs a name", { fields: { name: "required" } });
    patch.name = name;
  }
  if (input.poolSize !== undefined) {
    if (!Number.isInteger(input.poolSize) || (input.poolSize as number) < 1 || (input.poolSize as number) > MAX_POOL_SIZE)
      throw new ServiceError("invalid", `poolSize must be 1 to ${MAX_POOL_SIZE}`, { fields: { poolSize: `1 to ${MAX_POOL_SIZE}` } });
    patch.poolSize = input.poolSize as number;
  }
  if (input.chatModel !== undefined) patch.chatModel = input.chatModel === null ? null : str(input.chatModel, 60) || null;
  if (!Object.keys(patch).length) return { device: deviceView(d) };
  const key = await serverSigningKey();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(devices).set(patch).where(eq(devices.id, d.id)).returning();
    if (patch.poolSize !== undefined || patch.chatModel !== undefined) await sendToDevice(tx, key, d.id, "settings.update", { poolSize: row.poolSize, chatModel: row.chatModel });
    return row;
  });
  wake(d.id);
  return { device: deviceView(updated) };
}

/**
 * Unpair: the device can no longer get a token, its open stream ends within seconds, and what it was doing is canceled (the daemon
 * stops them when it learns it was unpaired; whatever it pushed stays on its branch).
 */
export async function revokeDevice(actor: Actor, id: string) {
  const db = await getDb();
  const d = await ownDevice(actor, id, db);
  const now = new Date();
  const ended = await db.transaction(async (tx) => {
    await tx.update(devices).set({ revokedAt: now }).where(eq(devices.id, d.id));
    await tx.delete(deviceTokens).where(eq(deviceTokens.deviceId, d.id));
    return tx
      .update(deviceJobs)
      .set({ state: "canceled", finishedAt: now, updatedAt: now, error: "The device was unpaired" })
      .where(and(eq(deviceJobs.deviceId, d.id), inArray(deviceJobs.state, ACTIVE)))
      .returning();
  });
  for (const j of ended) signalJob(j);
  wake(d.id);
  return { ok: true as const, canceled: ended.length };
}

// ───────── people: jobs on an issue ─────────

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** `wh/WH-12-fix-the-login-3f2a1c`: the issue ref (so the GitHub App links it), its title, and a bit of the job id, since an issue can run again. */
export const jobBranch = (ref: string, title: string, jobId: string) => `wh/${[ref, slugify(title), jobId.replace(/-/g, "").slice(0, 6)].filter(Boolean).join("-")}`;

/** What a run left behind, apart from how it ended: nothing, a pushed branch, an open pull request, or a branch whose pull request GitHub refused. */
export type JobDelivery = "none" | "pushed" | "pr_opened" | "pr_failed";

/**
 * Derived from what the run recorded, so it needs no column of its own. Null while a run has not finished (or was never taken up),
 * because it has nothing to report yet. A pull request is opened a moment after the run finishes, so a pushed run reads `pushed`
 * until that attempt lands.
 */
export function jobDelivery(state: DeviceJobState, result: Record<string, unknown>): JobDelivery | null {
  if (result.pullRequest) return "pr_opened";
  if (result.pullRequestError) return "pr_failed";
  if (result.pushed === true) return "pushed";
  return state === "succeeded" || state === "failed" || state === "canceled" ? "none" : null;
}

function jobView(j: typeof deviceJobs.$inferSelect, extra: { deviceName?: string | null; repositoryName?: string | null } = {}) {
  return {
    id: j.id,
    state: j.state,
    model: j.model,
    branch: j.branch,
    baseBranch: j.baseBranch,
    continuesJobId: j.continuesJobId,
    deviceId: j.deviceId,
    deviceName: extra.deviceName ?? null,
    repositoryId: j.repositoryId,
    repositoryName: extra.repositoryName ?? null,
    result: j.result,
    delivery: jobDelivery(j.state, j.result),
    error: j.error,
    cancelRequested: !!j.cancelRequestedAt,
    createdAt: j.createdAt.toISOString(),
    acceptedAt: j.acceptedAt?.toISOString() ?? null,
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}
export type JobView = ReturnType<typeof jobView>;

/** The repositories of a team an agent can work in from a fresh clone: connected to GitHub and not retired. */
async function runnableRepositories(q: Q, teamId: string) {
  const rows = await q.select().from(repositories).where(and(eq(repositories.teamId, teamId), eq(repositories.provider, "github")));
  return rows.filter((r) => r.githubFullName && r.lifecycle !== "retired");
}

/**
 * The issue's runs, newest first, and what a new one can use: the person's own online devices, the team's GitHub repositories, and
 * the models each device offers. Anyone who can read the issue sees its runs.
 */
export async function issueJobs(actor: Actor, ref: string) {
  const db = await getDb();
  const { issue, team } = await resolveIssue(actor, ref, db);
  const rows = await db
    .select({ job: deviceJobs, deviceName: devices.name, repositoryName: repositories.displayName })
    .from(deviceJobs)
    .innerJoin(devices, eq(devices.id, deviceJobs.deviceId))
    .leftJoin(repositories, eq(repositories.id, deviceJobs.repositoryId))
    .where(and(eq(deviceJobs.issueId, issue.id), eq(deviceJobs.teamId, team.id)))
    .orderBy(desc(deviceJobs.createdAt))
    .limit(50);
  const repos = await runnableRepositories(db, team.id);
  const mine = actor.kind === "human" ? await listDevices(actor) : [];
  return {
    jobs: rows.map((r) => jobView(r.job, { deviceName: r.deviceName, repositoryName: r.repositoryName })),
    devices: mine.map((d) => ({ id: d.id, name: d.name, status: d.status, models: d.models, poolSize: d.poolSize, activeJobs: d.activeJobs })),
    repositories: repos.map((r) => ({ id: r.id, name: r.displayName, fullName: r.githubFullName, defaultBranch: r.defaultBranch })),
  };
}

/** A branch name a run may start from: what git accepts, without the tricks (`..`, a leading `-`, `@{`). */
export function validBaseBranch(v: unknown): string | null {
  const s = str(v, 200);
  if (!s || !/^[A-Za-z0-9._\/-]+$/.test(s) || s.startsWith("-") || s.startsWith("/") || s.endsWith("/") || s.endsWith(".lock") || s.includes("..") || s.includes("//")) return null;
  return s;
}

/**
 * The branches a run of the issue can start from, in one of its team's repositories: from GitHub when the server has the App, the
 * default branch first. Without GitHub (or when it fails) just the default branch, and `listed: false` so the page offers a text box.
 */
export async function runBranches(actor: Actor, ref: string, repositoryId: string) {
  const db = await getDb();
  const { team } = await resolveIssue(actor, ref, db);
  const repo = (await runnableRepositories(db, team.id)).find((r) => r.id === repositoryId);
  if (!repo) throw new ServiceError("not_found", "Repository not found");
  const def = repo.defaultBranch || "main";
  const gh = github();
  if (!gh || !repo.githubInstallationId || !repo.githubRepoId) return { defaultBranch: def, branches: [def], listed: false };
  try {
    const names = await gh.api.branches(repo.githubInstallationId, repo.githubRepoId);
    return { defaultBranch: def, branches: [def, ...names.filter((n) => n !== def).sort()], listed: true };
  } catch {
    return { defaultBranch: def, branches: [def], listed: false };
  }
}

/**
 * The earlier run a "Continue" carries on from: one of this issue's runs that has finished and pushed its branch, with no other run on
 * that branch right now (two agents on one branch would push over each other). Its final summary is handed to the new run.
 */
async function continuable(q: Q, issueId: string, jobId: unknown) {
  const id = str(jobId, 60);
  const [job] = isUuid(id) ? await q.select().from(deviceJobs).where(and(eq(deviceJobs.id, id), eq(deviceJobs.issueId, issueId))) : [];
  if (!job) throw new ServiceError("invalid", "There is no such run of this issue to continue", { fields: { continuesJobId: "a run of this issue" } });
  if (!isFinalState(job.state)) throw new ServiceError("conflict", "That run has not finished yet");
  if (job.result?.pushed !== true) throw new ServiceError("invalid", "That run pushed nothing, so there is nothing to continue from: start over instead");
  const [busy] = await q.select({ id: deviceJobs.id }).from(deviceJobs).where(and(eq(deviceJobs.branch, job.branch), inArray(deviceJobs.state, ACTIVE))).limit(1);
  if (busy) throw new ServiceError("conflict", "Another run is already working on that branch");
  const [last] = await q
    .select({ data: deviceJobEvents.data })
    .from(deviceJobEvents)
    .where(and(eq(deviceJobEvents.jobId, job.id), eq(deviceJobEvents.type, "result")))
    .orderBy(desc(deviceJobEvents.seq))
    .limit(1);
  const summary = typeof last?.data?.text === "string" ? (last.data.text as string) : null;
  return { job, summary };
}

/**
 * "Run on device": `{ deviceId, repositoryId?, model, baseBranch?, continuesJobId? }`. With `continuesJobId` the new run works on that
 * earlier run's branch, from its commits, with the same repository and pull request target; otherwise it starts a new branch. The person must be able to edit the issue and own the device, which must be
 * online. The repository is one of the issue team's GitHub repositories (the only one, if the team has one). The job is offered to
 * the device as a signed message carrying everything it needs, and expires if the device does not take it within a minute.
 */
export async function runOnDevice(actor: Actor, ref: string, input: Record<string, unknown>) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can send work to their machine");
  const db = await getDb();
  const { issue, team, ref: issueRef } = await resolveIssue(actor, ref, db, "edit");
  const device = await ownDevice(actor, str(input.deviceId, 60), db).catch(() => {
    throw new ServiceError("invalid", "Pick one of your devices", { fields: { deviceId: "one of your paired devices" } });
  });
  if (!deviceOnline(device)) throw new ServiceError("conflict", `${device.name} is offline. Start the daemon on it and try again.`);
  const repos = await runnableRepositories(db, team.id);
  // "Continue": carry on from an earlier run of this issue, on its branch and from its commits, with what it said at the end.
  const previous = input.continuesJobId === undefined || input.continuesJobId === null ? null : await continuable(db, issue.id, input.continuesJobId);
  const repoId = previous ? (previous.job.repositoryId ?? "") : str(input.repositoryId, 60);
  const repo = repoId ? repos.find((r) => r.id === repoId) : repos.length === 1 ? repos[0] : undefined;
  if (!repo)
    throw new ServiceError("invalid", repos.length ? "Pick the repository to work in" : "This team has no GitHub repository the agent can clone yet", {
      fields: { repositoryId: repos.length ? "one of the team's GitHub repositories" : "connect a GitHub repository first" },
    });
  const view = deviceView(device);
  const model = str(input.model, 60);
  if (!model || !view.models.includes(model)) throw new ServiceError("invalid", `Pick a model ${device.name} offers: ${view.models.join(", ")}`, { fields: { model: view.models.join(", ") } });
  const baseBranch = previous
    ? previous.job.baseBranch || repo.defaultBranch || "main"
    : input.baseBranch === undefined || input.baseBranch === ""
      ? repo.defaultBranch || "main"
      : validBaseBranch(input.baseBranch);
  if (!baseBranch) throw new ServiceError("invalid", "That is not a branch name", { fields: { baseBranch: "a branch of the repository" } });

  const id = crypto.randomUUID();
  const branch = previous ? previous.job.branch : jobBranch(issueRef, issue.title, id);
  const offerExpiresAt = new Date(Date.now() + OFFER_TTL_MS);
  const key = await serverSigningKey();
  const job = await db.transaction(async (tx) => {
    const [j] = await tx
      .insert(deviceJobs)
      .values({ id, teamId: team.id, workspaceId: actor.workspaceId, deviceId: device.id, issueId: issue.id, repositoryId: repo.id, model, branch, baseBranch, continuesJobId: previous?.job.id ?? null, createdBy: actor.id, offerExpiresAt })
      .returning();
    await sendToDevice(tx, key, device.id, "job.offer", {
      jobId: j.id,
      expiresAt: offerExpiresAt.toISOString(),
      model,
      branch,
      baseBranch,
      // Where the worktree starts: the earlier run's pushed branch when continuing, else the base.
      startFrom: previous ? branch : baseBranch,
      previous: previous ? { jobId: previous.job.id, state: previous.job.state, summary: previous.summary, error: previous.job.error } : null,
      // Board writes come with the MCP redesign; until then the agent works only in its worktree.
      boardAccess: "none",
      issue: { id: issue.id, ref: issueRef, title: issue.title, body: issue.body, team: { key: team.key, name: team.name } },
      repository: {
        id: repo.id,
        name: repo.displayName,
        fullName: repo.githubFullName,
        cloneUrl: `https://github.com/${repo.githubFullName}.git`,
        defaultBranch: repo.defaultBranch,
        pathLimit: repo.pathLimit,
      },
      requestedBy: { id: actor.id, name: actor.name },
    });
    return j;
  });
  wake(device.id);
  signalJob(job);
  return { job: jobView(job, { deviceName: device.name, repositoryName: repo.displayName }) };
}

/** A job the actor can read, through its issue's team. */
async function readableJob(actor: Actor, jobId: string) {
  if (!isUuid(jobId)) throw new ServiceError("not_found", "Job not found");
  const db = await getDb();
  const [row] = await db
    .select({ job: deviceJobs, issueNumber: issues.number, teamKey: teams.key })
    .from(deviceJobs)
    .innerJoin(issues, eq(issues.id, deviceJobs.issueId))
    .innerJoin(teams, eq(teams.id, deviceJobs.teamId))
    .where(and(eq(deviceJobs.id, jobId), eq(deviceJobs.workspaceId, actor.workspaceId)));
  if (!row) throw new ServiceError("not_found", "Job not found");
  await resolveIssue(actor, `${row.teamKey}-${row.issueNumber}`, db).catch(() => {
    throw new ServiceError("not_found", "Job not found");
  });
  return row.job;
}

/** A job's progress after event `after` (exclusive), oldest first, at most `limit`. */
export async function jobEvents(actor: Actor, jobId: string, opts: { after?: number; limit?: number } = {}) {
  const job = await readableJob(actor, jobId);
  const db = await getDb();
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const rows = await db
    .select()
    .from(deviceJobEvents)
    .where(and(eq(deviceJobEvents.jobId, job.id), gt(deviceJobEvents.seq, opts.after ?? -1)))
    .orderBy(asc(deviceJobEvents.seq))
    .limit(limit);
  return { job: jobView(job), events: rows.map((e) => ({ seq: e.seq, at: e.at.toISOString(), type: e.type, data: e.data })) };
}

/**
 * Stop a job. An offer not yet taken ends at once; a job the daemon holds is asked to stop (a signed cancel) and ends when the daemon
 * reports it. The person who started it, or the device's owner, can cancel.
 */
export async function cancelJob(actor: Actor, jobId: string) {
  const job = await readableJob(actor, jobId);
  const db = await getDb();
  const [d] = await db.select().from(devices).where(eq(devices.id, job.deviceId));
  if (actor.kind !== "human" || (job.createdBy !== actor.id && d?.ownerId !== actor.id)) throw new ServiceError("forbidden", "Only the person who started it or the device's owner can cancel a run");
  if (isFinalState(job.state)) return { job: jobView(job) };
  const now = new Date();
  const key = await serverSigningKey();
  const updated = await db.transaction(async (tx) => {
    const [row] =
      job.state === "offered"
        ? await tx
            .update(deviceJobs)
            .set({ state: "canceled", cancelRequestedAt: now, finishedAt: now, updatedAt: now, error: `Canceled by ${actor.name}` })
            .where(and(eq(deviceJobs.id, job.id), eq(deviceJobs.state, "offered")))
            .returning()
        : await tx
            .update(deviceJobs)
            .set({ cancelRequestedAt: now, updatedAt: now })
            .where(and(eq(deviceJobs.id, job.id), inArray(deviceJobs.state, ["accepted", "running"])))
            .returning();
    if (row) await sendToDevice(tx, key, job.deviceId, "job.cancel", { jobId: job.id, requestedBy: { id: actor.id, name: actor.name } });
    return row;
  });
  wake(job.deviceId);
  if (updated) signalJob(updated);
  return { job: jobView(updated ?? job) };
}
