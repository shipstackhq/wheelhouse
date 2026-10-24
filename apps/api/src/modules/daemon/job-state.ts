import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { DeviceJobState } from "../../db/schema";
import { ServiceError } from "../../lib/service";
import { isUuid } from "../../common/uuid";
import { ACTIVE, type Device } from "./device-common";
import { signalJob } from "./device-stream";

/** A job's row: finding it for a device and moving it between states (one place, so two writers cannot both win). See wheelhouse-cli/daemon/DESIGN.md. */
const { deviceJobs } = schema;

export async function deviceJob(device: Device, jobId: string) {
  if (!isUuid(jobId)) throw new ServiceError("not_found", "No such job");
  const db = await getDb();
  const [j] = await db.select().from(deviceJobs).where(and(eq(deviceJobs.id, jobId), eq(deviceJobs.deviceId, device.id)));
  if (!j) throw new ServiceError("not_found", "No such job");
  return j;
}

/** Move a job to `to` only if it is still in one of `from`; false when something else got there first. */
export async function transition(jobId: string, from: DeviceJobState[], set: Partial<typeof deviceJobs.$inferInsert> & { state: DeviceJobState }) {
  const db = await getDb();
  const [row] = await db
    .update(deviceJobs)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(deviceJobs.id, jobId), inArray(deviceJobs.state, from)))
    .returning();
  if (row) signalJob(row);
  return row ?? null;
}

export async function finishJobRow(j: typeof deviceJobs.$inferSelect, state: DeviceJobState, extra: { error?: string | null; result?: Record<string, unknown> } = {}) {
  return transition(j.id, ACTIVE, { state, finishedAt: new Date(), error: extra.error ?? null, ...(extra.result ? { result: extra.result } : {}) });
}
