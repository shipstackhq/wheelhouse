import { schema } from "../../db";
import type { Actor } from "../../common/actor";
import type { Q } from "../database/transaction";
import { deferPublish } from "./event-bus";

const { events } = schema;

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
