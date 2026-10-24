import { and, asc, desc, gt } from "drizzle-orm";
import { getDb, schema } from "../db";
import { AuthError } from "./access";
import type { Actor } from "../common/actor";
import { bus, type StreamEvent } from "./event-bus";
import type { StreamScope } from "./stream-scope";
import { ServiceError } from "./service";
import { eventStream, parseSince, SSE_HEADERS } from "./sse";

export { SSE_HEADERS };

/** Browsers open one stream per team tab plus one for the dashboard; this is generous for a person and fatal for a flood. */
export const MAX_STREAMS_PER_USER = 12;
const open = new Map<string, number>();

const toStreamEvent = (r: typeof schema.events.$inferSelect): StreamEvent => ({
  workspaceId: r.workspaceId,
  teamId: r.teamId,
  seq: r.seq,
  type: r.type,
  entity: r.entity,
  entityId: r.entityId,
  actorKind: r.actorKind,
  actorName: r.actorName,
  summary: r.summary,
});

/** What a host sends: the event stream, or a short refusal. */
export type StreamResult = { status: 200; headers: typeof SSE_HEADERS; body: ReadableStream<Uint8Array> } | { status: number; text: string; headers?: Record<string, string> };

/**
 * Shared by the team stream and the dashboard's workspace stream: the caller must be a person signed in with a session
 * cookie, the scope is resolved to exactly their own workspace, and then the event stream is handed back. `getActor` resolves the
 * caller the host's way; `signal` ends the stream when the client goes away.
 */
export async function openStream(i: {
  getActor: () => Promise<Actor>;
  scopeFor: (actor: Actor) => Promise<StreamScope>;
  lastEventId: string | null;
  since: string | null;
  signal: AbortSignal;
}): Promise<StreamResult> {
  let actor: Actor;
  try {
    actor = await i.getActor();
  } catch (e) {
    if (e instanceof AuthError) return { status: 401, text: "Not signed in" };
    throw e;
  }
  if (actor.kind !== "human") return { status: 403, text: "Streams are for people signed in to the app" };

  let resolved;
  try {
    resolved = await i.scopeFor(actor);
  } catch (e) {
    if (e instanceof ServiceError) return { status: 404, text: "Not found" };
    throw e;
  }

  const n = open.get(actor.id) ?? 0;
  if (n >= MAX_STREAMS_PER_USER) return { status: 429, text: "Too many open streams", headers: { "Retry-After": "10" } };
  open.set(actor.id, n + 1);

  const db = await getDb();
  const { scope, where, allow, recheck } = resolved;
  const body = eventStream({
    subscribe: (fn) => bus.subscribe(scope, (e) => (!allow || allow(e)) && fn(e)),
    replay: async (since, limit) =>
      (await db.select().from(schema.events).where(and(where, gt(schema.events.seq, since))).orderBy(asc(schema.events.seq)).limit(limit)).map(toStreamEvent),
    latestSeq: async () => (await db.select({ seq: schema.events.seq }).from(schema.events).where(where).orderBy(desc(schema.events.seq)).limit(1))[0]?.seq ?? 0,
    recheck,
    since: parseSince(i.lastEventId, i.since),
    signal: i.signal,
    onClose: () => {
      const left = (open.get(actor.id) ?? 1) - 1;
      if (left <= 0) open.delete(actor.id);
      else open.set(actor.id, left);
    },
  });
  return { status: 200, headers: SSE_HEADERS, body };
}
