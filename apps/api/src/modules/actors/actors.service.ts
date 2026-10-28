import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "../../db";
import type { AvatarStyle } from "@wheelhouse/shared/agents/avatar";
import { isUuid } from "../../common/uuid";
import { Database } from "../../platform/database/database";
import { effectiveProfile } from "../agents/index";
import { avatarUrl } from "../images/index";

const { users, workspaceAgents } = schema;

/** How to draw someone: an uploaded picture, a generated agent face, or nothing (show initials). */
export type ActorAvatar = { type: "image"; url: string } | { type: "generated"; style: AvatarStyle; seed: string } | null;
/** Anyone the UI shows. `id` is null when the author no longer resolves. */
export type ActorRef = { kind: "human" | "agent"; id: string | null; name: string; avatar: ActorAvatar };
/** What a row stores about its author: the kind, the `author_id` and the name at the time. */
export type ActorInput = { kind: "human" | "agent"; id: string | null; name: string; agentId?: string | null };

/**
 * The one place that turns "who wrote this" into an `ActorRef` with a picture. Presenters call it; no avatar logic lives elsewhere.
 * One query per kind per call, whatever the number of refs. An agent's `author_id` can be a workspace agent id, an api key id or a
 * device id, so it counts as a roster agent only when it matches a `workspace_agents` row of this workspace; otherwise it keeps its
 * stored name and no picture.
 */
@Injectable()
export class ActorsService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async resolve(workspaceId: string, refs: ActorInput[]): Promise<ActorRef[]> {
    // A row's `author_agent_id` (the roster agent) wins over `author_id` (the user or key that made the call).
    const key = (r: ActorInput) => (r.kind === "agent" && r.agentId) || r.id;
    const ids = (kind: ActorInput["kind"]) => [...new Set(refs.filter((r) => r.kind === kind).map(key).filter((id): id is string => !!id && isUuid(id)))];
    const humanIds = ids("human");
    const agentIds = ids("agent");
    const [people, agents] = await Promise.all([
      humanIds.length ? this.db.q.select({ id: users.id, name: users.name, avatarKey: users.avatarKey }).from(users).where(inArray(users.id, humanIds)) : [],
      agentIds.length
        ? this.db.q
            .select({ id: workspaceAgents.id, source: workspaceAgents.source, catalogSlug: workspaceAgents.catalogSlug, pinnedVersion: workspaceAgents.pinnedVersion, profile: workspaceAgents.profile })
            .from(workspaceAgents)
            .where(and(eq(workspaceAgents.workspaceId, workspaceId), inArray(workspaceAgents.id, agentIds)))
        : [],
    ]);
    const person = new Map(people.map((u) => [u.id, u]));
    const agent = new Map(agents.map((a) => [a.id, a]));

    return refs.map((r): ActorRef => {
      if (r.kind === "human") {
        const u = r.id ? person.get(r.id) : undefined;
        if (!u) return { kind: "human", id: null, name: r.name, avatar: null };
        const url = avatarUrl(u.id, u.avatarKey);
        return { kind: "human", id: u.id, name: u.name, avatar: url ? { type: "image", url } : null };
      }
      const k = key(r);
      const a = k ? agent.get(k) : undefined;
      if (a) {
        const p = effectiveProfile(a);
        return { kind: "agent", id: a.id, name: r.name, avatar: { type: "generated", style: p.avatar.style, seed: p.avatar.seed } };
      }
      return { kind: "agent", id: r.id, name: r.name, avatar: null };
    });
  }
}
