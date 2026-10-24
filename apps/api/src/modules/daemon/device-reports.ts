import { and, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { DeviceJobState } from "../../db/schema";
import { serverSigningKey } from "./daemon-crypto";
import { isUuid } from "../teams/team-access";
import { type Device, str } from "./device-common";
import { sendToDevice, wake } from "./device-stream";
import { finishJobRow, transition } from "./job-state";

/** What a machine reports: its capabilities, hello and heartbeat, and settling what it says it still holds. See wheelhouse-cli/daemon/DESIGN.md. */
const { devices, deviceJobs } = schema;

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
 * reconciles (`reconcileJobs`): a job the daemon still holds is running again, one it no longer knows about (it restarted and lost it) is lost.
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
  await reconcileJobs(device, reported, "hello");
  return { device: { id: d.id, name: d.name, poolSize: d.poolSize, chatModel: d.chatModel } };
}

/** `{ running: [jobId], free, onBattery }`, every 30 seconds. Keeps the device online, and settles its unreachable jobs the way a hello does. */
export async function deviceHeartbeat(device: Device, input: Record<string, unknown>) {
  const db = await getDb();
  const caps = { ...(device.capabilities ?? {}), power: { onBattery: input.onBattery === true }, pool: { free: Number.isInteger(input.free) ? input.free : null } };
  await db.update(devices).set({ lastSeenAt: new Date(), capabilities: caps }).where(eq(devices.id, device.id));
  await reconcileJobs(device, new Set((Array.isArray(input.running) ? input.running : []).filter((id): id is string => typeof id === "string" && isUuid(id))), "heartbeat");
  return { ok: true as const };
}

/**
 * What the daemon says it holds is the only evidence a run is gone. For this device's jobs:
 * - an unreachable job the daemon reports is running again; one it does not report is lost (it is no longer there);
 * - a hello (the daemon just started) that leaves out an accepted or running job loses it too, since a restart forgets its jobs. A
 *   heartbeat does not: its list can be a moment older than an accept;
 * - a job a person marked lost that the daemon still reports comes back, unless a newer run has taken over its branch, in which case
 *   the old agent is told to stop (`supersede`).
 */
export async function reconcileJobs(device: Device, reported: Set<string>, source: "hello" | "heartbeat") {
  const db = await getDb();
  const states: DeviceJobState[] = source === "hello" ? ["accepted", "running", "unreachable"] : ["unreachable"];
  const open = await db.select().from(deviceJobs).where(and(eq(deviceJobs.deviceId, device.id), inArray(deviceJobs.state, states)));
  for (const j of open) {
    if (reported.has(j.id)) {
      if (j.state === "unreachable") await revive(j, ["unreachable"]);
    } else {
      await finishJobRow(j, "lost", { error: source === "hello" ? "The daemon restarted and no longer has this job" : "The daemon no longer has this job" });
    }
  }
  if (!reported.size) return;
  const marked = await db
    .select()
    .from(deviceJobs)
    .where(and(eq(deviceJobs.deviceId, device.id), eq(deviceJobs.state, "lost"), sql`${deviceJobs.markedLostBy} is not null`, inArray(deviceJobs.id, [...reported])));
  for (const j of marked) {
    if (await takenOverBy(j)) await supersede(device, j);
    else await revive(j, ["lost"]);
  }
}

/** Back to running (or setting up, if it had not started): the device is talking about it after all. */
export async function revive(j: typeof deviceJobs.$inferSelect, from: DeviceJobState[]) {
  return transition(j.id, from, { state: j.startedAt ? "running" : "accepted", unreachableSince: null, finishedAt: null, error: null, markedLostBy: null });
}

/** The id of a newer run on this run's branch (one that was offered and not refused), if there is one: it has taken the branch over. */
export async function takenOverBy(j: typeof deviceJobs.$inferSelect) {
  const db = await getDb();
  const [t] = await db
    .select({ id: deviceJobs.id })
    .from(deviceJobs)
    .where(and(eq(deviceJobs.issueId, j.issueId), eq(deviceJobs.branch, j.branch), sql`${deviceJobs.id} <> ${j.id}`, gt(deviceJobs.createdAt, j.createdAt), notInArray(deviceJobs.state, ["rejected", "expired"])))
    .limit(1);
  return t?.id ?? null;
}

/** Tell a device whose run was taken over to stop it, without pushing. Asked once: the daemon answers with its finish. */
export async function supersede(device: Device, j: typeof deviceJobs.$inferSelect) {
  if (j.cancelRequestedAt) return;
  const db = await getDb();
  const key = await serverSigningKey();
  await db.transaction(async (tx) => {
    const [row] = await tx.update(deviceJobs).set({ cancelRequestedAt: new Date(), updatedAt: new Date() }).where(and(eq(deviceJobs.id, j.id), isNull(deviceJobs.cancelRequestedAt))).returning();
    if (row) await sendToDevice(tx, key, device.id, "job.cancel", { jobId: j.id, superseded: true });
  });
  wake(device.id);
}
