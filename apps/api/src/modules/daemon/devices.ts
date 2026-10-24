import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { type Actor } from "../../lib/access";
import { serverSigningKey } from "./daemon-crypto";
import { ServiceError, type Q } from "../../lib/service";
import { isUuid } from "../../lib/team-access";
import { ACTIVE, DEFAULT_MODELS, type Device, MAX_POOL_SIZE, ONLINE_WINDOW_MS, str } from "./device-common";
import { sendToDevice, signalJob, wake } from "./device-stream";

/** A person's machines: list, rename, resize, unpair. See wheelhouse-cli/daemon/DESIGN.md. */
const { devices, deviceTokens, deviceJobs } = schema;

export const deviceOnline = (d: Pick<Device, "lastSeenAt" | "revokedAt">, now = Date.now()) => !d.revokedAt && !!d.lastSeenAt && now - d.lastSeenAt.getTime() < ONLINE_WINDOW_MS;

export function deviceView(d: Device) {
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

export async function ownDevice(actor: Actor, id: string, q?: Q) {
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
