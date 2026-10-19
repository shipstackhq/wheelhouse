import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import type { Scope, StreamEvent } from "./event-bus";
import { visibleProjectIds } from "./project-access";
import { getProject, ServiceError } from "./service";

/** What a stream listens to (`scope`, on the bus) and which rows of the log it may replay (`where`). Always the caller's own team. */
export type StreamScope = {
  scope: Scope;
  where: ReturnType<typeof eq>;
  /** Live events the caller may not see are dropped here; the replay already honours the same limit through `where`. */
  allow?: (e: StreamEvent) => boolean;
  /** Asked while the stream is open; false ends it. Also the place where a scope refreshes what it allows. */
  recheck?: () => Promise<boolean>;
};

/** One project's changes, for a team member. A project of another team is a plain not-found (getProject is team scoped). */
export function projectScope(key: string) {
  return async (actor: Actor): Promise<StreamScope> => {
    const p = await getProject(actor, key);
    return {
      scope: { project: p.id },
      where: eq(schema.events.projectId, p.id),
      // Removed from the project (or from the workspace) while watching: the stream ends, and the reconnect is a plain 404.
      recheck: async () => {
        try {
          await getProject(actor, key);
          return true;
        } catch (e) {
          if (e instanceof ServiceError) return false;
          throw e;
        }
      },
    };
  };
}

/**
 * Everything in the caller's team that they can open, for the dashboard. The team comes from the session, never from the
 * request. The set of projects is read when the stream opens, so someone removed from a project keeps hearing about it until
 * their page reconnects (a few minutes at most with the browser's own retry); nothing is ever replayed from a project they were not in.
 */
export function teamScope() {
  return async (actor: Actor): Promise<StreamScope> => {
    const visible = await visibleProjectIds(await getDb(), actor);
    const inTeam = eq(schema.events.teamId, actor.teamId);
    if (!visible) return { scope: { team: actor.teamId }, where: inTeam };
    let set = new Set(visible);
    return {
      scope: { team: actor.teamId },
      where: and(inTeam, visible.length ? inArray(schema.events.projectId, visible) : sql`false`) as ReturnType<typeof eq>,
      allow: (e) => set.has(e.projectId),
      // Projects joined or left while the page is open: the live set follows, so a removal stops events within a few seconds.
      recheck: async () => {
        set = new Set((await visibleProjectIds(await getDb(), actor)) ?? []);
        return true;
      },
    };
  };
}
