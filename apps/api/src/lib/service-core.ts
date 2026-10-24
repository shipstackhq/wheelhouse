import { DEFAULT_STATUS_DEFS } from "@wheelhouse/shared/status-roles";
import { eq } from "drizzle-orm";
import { schema, type DB } from "../db";
import type { Actor } from "./access";
import { deferPublish } from "./event-bus";
import { ServiceError } from "./service-error";

const { events } = schema;

export { ServiceError };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export const DEFAULT_STATUSES = DEFAULT_STATUS_DEFS.map((c) => c.name);

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Q = DB | Tx;

/**
 * Lock a row for the rest of the transaction and read it as it is NOW. A version check that reads, compares and writes is only
 * safe if two edits from the same version cannot both read it before either writes; on Postgres (not on the single-connection
 * embedded database the tests use) they can. The second one waits here for the first to commit, then sees its version.
 */
export async function lockRow<T extends { id: string }>(tx: Tx, table: typeof schema.issues | typeof schema.nodes | typeof schema.docs, row: T): Promise<T> {
  const [fresh] = await tx.select().from(table).where(eq(table.id, row.id)).for("update");
  return (fresh as unknown as T | undefined) ?? row;
}

export async function emit(
  q: Q,
  actor: Actor,
  teamId: string,
  e: { type: string; entity: (typeof events.$inferInsert)["entity"]; entityId: string; summary: string; data?: Record<string, unknown> },
) {
  const [row] = await q
    .insert(events)
    .values({
      workspaceId: actor.workspaceId,
      teamId,
      actorKind: actor.kind,
      actorId: actor.id,
      actorName: actor.name,
      type: e.type,
      entity: e.entity,
      entityId: e.entityId,
      summary: e.summary,
      data: e.data ?? {},
      sessionId: actor.kind === "agent" ? (actor.sessionId ?? null) : null,
    })
    .returning({ seq: events.seq });
  // Tell open browser streams (WH-1). Inside a transaction this waits for the commit, so a watcher never re-reads old data.
  deferPublish(q, {
    workspaceId: actor.workspaceId,
    teamId,
    seq: row.seq,
    type: e.type,
    entity: e.entity,
    entityId: e.entityId,
    actorKind: actor.kind,
    actorName: actor.name,
    summary: e.summary,
  });
}

/** Shallow diff for event payloads: { field: { from, to } } */
export function diff<T extends Record<string, unknown>>(before: T, patch: Partial<T>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(patch)) {
    const a = before[k];
    const b = patch[k as keyof T];
    if (b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}
