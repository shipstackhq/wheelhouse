import "server-only";
import { and, asc, desc, gt } from "drizzle-orm";
import { getDb, schema } from "@wheelhouse/core/db";
import { actorFromRequest, AuthError, type Actor } from "./auth";
import { bus, type StreamEvent } from "@wheelhouse/core/lib/event-bus";
import type { StreamScope } from "@wheelhouse/core/lib/stream-scope";
import { ServiceError } from "@wheelhouse/core/lib/service";
import { eventStream, parseSince, SSE_HEADERS } from "@wheelhouse/core/lib/sse";

/** Browsers open one stream per project tab plus one for the dashboard; this is generous for a person and fatal for a flood. */
export const MAX_STREAMS_PER_USER = 12;
const open = new Map<string, number>();

const toStreamEvent = (r: typeof schema.events.$inferSelect): StreamEvent => ({
  teamId: r.teamId,
  projectId: r.projectId,
  seq: r.seq,
  type: r.type,
  entity: r.entity,
  entityId: r.entityId,
  actorKind: r.actorKind,
  actorName: r.actorName,
  summary: r.summary,
});

/**
 * Shared by the project stream and the dashboard's team stream: authenticate with the session cookie, resolve the scope
 * to exactly the caller's own team, then hand back the event stream.
 */
export async function openStream(request: Request, scopeFor: (actor: Actor) => Promise<StreamScope>) {
  let actor;
  try {
    actor = await actorFromRequest();
  } catch (e) {
    if (e instanceof AuthError) return new Response("Not signed in", { status: 401 });
    throw e;
  }
  if (actor.kind !== "human") return new Response("Streams are for people signed in to the app", { status: 403 });

  let resolved;
  try {
    resolved = await scopeFor(actor);
  } catch (e) {
    if (e instanceof ServiceError) return new Response("Not found", { status: 404 });
    throw e;
  }

  const n = open.get(actor.id) ?? 0;
  if (n >= MAX_STREAMS_PER_USER) return new Response("Too many open streams", { status: 429, headers: { "Retry-After": "10" } });
  open.set(actor.id, n + 1);

  const url = new URL(request.url);
  const db = await getDb();
  const { scope, where } = resolved;
  const body = eventStream({
    subscribe: (fn) => bus.subscribe(scope, fn),
    replay: async (since, limit) =>
      (await db.select().from(schema.events).where(and(where, gt(schema.events.seq, since))).orderBy(asc(schema.events.seq)).limit(limit)).map(toStreamEvent),
    latestSeq: async () => (await db.select({ seq: schema.events.seq }).from(schema.events).where(where).orderBy(desc(schema.events.seq)).limit(1))[0]?.seq ?? 0,
    since: parseSince(request.headers.get("last-event-id"), url.searchParams.get("since")),
    signal: request.signal,
    onClose: () => {
      const left = (open.get(actor.id) ?? 1) - 1;
      if (left <= 0) open.delete(actor.id);
      else open.set(actor.id, left);
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}
