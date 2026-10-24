import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import type { Scope, StreamEvent } from "./event-bus";
import { visibleTeamIds } from "../modules/teams/team-access";
import { requireTeam, ServiceError } from "./service";

/** What a stream listens to (`scope`, on the bus) and which rows of the log it may replay (`where`). Always the caller's own workspace. */
export type StreamScope = {
  scope: Scope;
  where: ReturnType<typeof eq>;
  /** Live events the caller may not see are dropped here; the replay already honours the same limit through `where`. */
  allow?: (e: StreamEvent) => boolean;
  /** Asked while the stream is open; false ends it. Also the place where a scope refreshes what it allows. */
  recheck?: () => Promise<boolean>;
};

/** One team's changes, for a workspace member. A team of another workspace is a plain not-found (requireTeam is workspace scoped). */
export function teamScope(key: string) {
  return async (actor: Actor): Promise<StreamScope> => {
    const p = await requireTeam(actor, key);
    return {
      scope: { team: p.id },
      where: eq(schema.events.teamId, p.id),
      // Removed from the team (or from the workspace) while watching: the stream ends, and the reconnect is a plain 404.
      recheck: async () => {
        try {
          await requireTeam(actor, key);
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
 * Everything in the caller's workspace that they can open, for the dashboard. The workspace comes from the session, never from the
 * request. The set of teams is read when the stream opens, so someone removed from a team keeps hearing about it until
 * their page reconnects (a few minutes at most with the browser's own retry); nothing is ever replayed from a team they were not in.
 */
export function workspaceScope() {
  return async (actor: Actor): Promise<StreamScope> => {
    const visible = await visibleTeamIds(await getDb(), actor);
    const inWorkspace = eq(schema.events.workspaceId, actor.workspaceId);
    if (!visible) return { scope: { workspace: actor.workspaceId }, where: inWorkspace };
    let set = new Set(visible);
    return {
      scope: { workspace: actor.workspaceId },
      where: and(inWorkspace, visible.length ? inArray(schema.events.teamId, visible) : sql`false`) as ReturnType<typeof eq>,
      allow: (e) => set.has(e.teamId),
      // Teams joined or left while the page is open: the live set follows, so a removal stops events within a few seconds.
      recheck: async () => {
        set = new Set((await visibleTeamIds(await getDb(), actor)) ?? []);
        return true;
      },
    };
  };
}
