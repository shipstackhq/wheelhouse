import { eq } from "drizzle-orm";
import { schema } from "../db";
import type { Actor } from "./access";
import type { Scope } from "./event-bus";
import { getProject } from "./service";

/** What a stream listens to (`scope`, on the bus) and which rows of the log it may replay (`where`). Always the caller's own team. */
export type StreamScope = { scope: Scope; where: ReturnType<typeof eq> };

/** One project's changes, for a team member. A project of another team is a plain not-found (getProject is team scoped). */
export function projectScope(key: string) {
  return async (actor: Actor): Promise<StreamScope> => {
    const p = await getProject(actor, key);
    return { scope: { project: p.id }, where: eq(schema.events.projectId, p.id) };
  };
}

/** Everything in the caller's team, for the dashboard. The team comes from the session, never from the request. */
export function teamScope() {
  return async (actor: Actor): Promise<StreamScope> => ({ scope: { team: actor.teamId }, where: eq(schema.events.teamId, actor.teamId) });
}
