import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { teams, statuses, issues, events, nodes, docs, apiKeys, workSessions, nodeDrafts } = schema;

const DAY = 864e5;

/**
 * Every query of the dashboard: the read model that looks across areas, so it aggregates over other modules' tables (teams, statuses,
 * issues, the event log, nodes, docs, API keys, work sessions, node drafts, decisions, team members, repositories, memberships and
 * invites). That is the one exception to "a module reads only its own tables" (docs/nest-architecture.md): rebuilding these numbers
 * from service calls would be slow and pointless. It is read-only: nothing here writes. The only file in the module that touches
 * Drizzle; each method reads `this.db.q`. It decides nothing: the services work out what the rows mean.
 */
@Injectable()
export class DashboardRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── the snapshot the widgets share ─────────

  /**
   * Teams, statuses, issues, recent events (28 days), nodes and docs for one workspace, limited to the teams in `visible` (null: all of
   * them) and to one team when `teamId` is given.
   */
  async snapshot(workspaceId: string, visible: string[] | null, teamId: string) {
    const q = this.db.q;
    const ps = await q
      .select()
      .from(teams)
      .where(and(eq(teams.workspaceId, workspaceId), visible ? inArray(teams.id, visible) : undefined, teamId === "*" ? undefined : eq(teams.id, teamId)))
      .orderBy(asc(teams.createdAt));
    const pids = ps.map((p) => p.id);
    if (!pids.length) return { teams: ps, statuses: [], issues: [], events: [], nodes: [], docs: [] };
    const [cs, ts, es, ns, ds] = await Promise.all([
      q.select().from(statuses).where(inArray(statuses.teamId, pids)).orderBy(asc(statuses.position)),
      q.select().from(issues).where(inArray(issues.teamId, pids)),
      q
        .select()
        .from(events)
        .where(and(eq(events.workspaceId, workspaceId), inArray(events.teamId, pids), gte(events.createdAt, new Date(Date.now() - 28 * DAY))))
        .orderBy(desc(events.seq)),
      q
        .select({ id: nodes.id, teamId: nodes.teamId, name: nodes.name, layer: nodes.layer, stale: nodes.stale, staleReason: nodes.staleReason })
        .from(nodes)
        .where(inArray(nodes.teamId, pids)),
      q
        .select({ id: docs.id, teamId: docs.teamId, slug: docs.slug, title: docs.title, stale: docs.stale, staleReason: docs.staleReason })
        .from(docs)
        .where(and(inArray(docs.teamId, pids), isNull(docs.deletedAt))),
    ]);
    return { teams: ps, statuses: cs, issues: ts, events: es, nodes: ns, docs: ds };
  }

  // ───────── keys ─────────

  /** The workspace's API keys that are not revoked, most recently used first. */
  activeKeys(workspaceId: string) {
    return this.db.q
      .select({ id: apiKeys.id, name: apiKeys.name, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.lastUsedAt));
  }

  /** Every key of the workspace, revoked or not, by id and name. */
  keyNames(workspaceId: string) {
    return this.db.q.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.workspaceId, workspaceId));
  }

  // ───────── sync health ─────────

  /** Sessions of these teams that are still open and were seen within `activeMs`. */
  activeSessions(teamIds: string[], activeMs: number) {
    return this.db.q
      .select()
      .from(workSessions)
      .where(and(inArray(workSessions.teamId, teamIds), isNull(workSessions.endedAt), gte(workSessions.lastSeenAt, new Date(Date.now() - activeMs))));
  }

  /** Map drafts of these teams that wait for their code to land. */
  pendingNodeDrafts(teamIds: string[]) {
    return this.db.q
      .select({ id: nodeDrafts.id, teamId: nodeDrafts.teamId, nodeId: nodeDrafts.nodeId, authorName: nodeDrafts.authorName, confirm: nodeDrafts.confirm, createdAt: nodeDrafts.createdAt })
      .from(nodeDrafts)
      .where(and(inArray(nodeDrafts.teamId, teamIds), eq(nodeDrafts.status, "pending")));
  }

  // ───────── one team's focus ─────────

  async proposedDecisionCount(teamId: string): Promise<number> {
    const [{ n }] = await this.db.q
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.decisions)
      .where(and(eq(schema.decisions.teamId, teamId), eq(schema.decisions.status, "proposed")));
    return Number(n);
  }

  async teamMemberCount(teamId: string): Promise<number> {
    const [{ n }] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId));
    return Number(n);
  }

  // ───────── the setup checklist ─────────

  /** The rows the checklist is computed from, for one team of a workspace. */
  async checklistCounts(team: { id: string; workspaceId: string }) {
    const q = this.db.q;
    const [repos, [{ count: sessionCount }], [{ count: activeAgentKeyCount }], [{ count: nodeCount }], [{ count: memberCount }], [{ count: pendingInviteCount }]] = await Promise.all([
      q.select({ provider: schema.repositories.provider, lifecycle: schema.repositories.lifecycle }).from(schema.repositories).where(eq(schema.repositories.teamId, team.id)),
      q
        .select({ count: sql<number>`count(*)::int` })
        .from(workSessions)
        .where(eq(workSessions.teamId, team.id)),
      q
        .select({ count: sql<number>`count(*)::int` })
        .from(apiKeys)
        .innerJoin(schema.apiKeyTeams, eq(schema.apiKeyTeams.apiKeyId, apiKeys.id))
        .where(and(eq(schema.apiKeyTeams.teamId, team.id), isNull(apiKeys.revokedAt))),
      q.select({ count: sql<number>`count(*)::int` }).from(nodes).where(eq(nodes.teamId, team.id)),
      q.select({ count: sql<number>`count(*)::int` }).from(schema.memberships).where(eq(schema.memberships.workspaceId, team.workspaceId)),
      q
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.invites)
        .where(
          and(
            eq(schema.invites.kind, "join_workspace"),
            eq(schema.invites.workspaceId, team.workspaceId),
            isNull(schema.invites.usedAt),
            isNull(schema.invites.revokedAt),
            gt(schema.invites.expiresAt, new Date()),
          ),
        ),
    ]);
    return { repositories: repos, sessionCount, activeAgentKeyCount, nodeCount, memberCount, pendingInviteCount };
  }
}
