import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { sha256 } from "../auth/access";
import type { Actor } from "../../common/actor";
import { randomToken } from "../auth/auth-core";
import { publicKeyFromRaw, rawPublicKey, serverSigningKey } from "./daemon-crypto";
import { rateLimit } from "../../common/rate-limit";
import { ServiceError } from "../../lib/service";
import { workspaceRoleOf } from "../teams/team-access";
import { PAIRING_POLL_INTERVAL_S, PAIRING_TTL_MS, str } from "./device-common";
import { deviceView } from "./devices";

/** Pairing a machine (RFC 8628): the machine starts and polls, a person approves or denies. See wheelhouse-cli/daemon/DESIGN.md. */
const { devices, devicePairings } = schema;

// No vowels or look-alikes, so a code is easy to read aloud and never spells a word.
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export function userCode() {
  const pick = () => Array.from(crypto.randomBytes(4), (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join("");
  return `${pick()}-${pick()}`;
}
export const normalizeUserCode = (v: unknown) => {
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

export async function pendingPairing(code: unknown) {
  const c = normalizeUserCode(code);
  if (!c) throw new ServiceError("not_found", "That code is not valid. Check it on the machine and try again.");
  const db = await getDb();
  const [p] = await db.select().from(devicePairings).where(eq(devicePairings.userCode, c));
  if (!p || p.state !== "pending" || p.expiresAt < new Date()) throw new ServiceError("not_found", "That code is not valid or has expired. Start pairing again on the machine.");
  return p;
}

/** Only people who can work in the workspace pair machines: a viewer or guest cannot run agents. */
export async function requirePairer(actor: Actor) {
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
