import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import { checklistStatus, type ChecklistState } from "./setup-checklist";
import { requireTeam } from "./service-teams";

const { nodes, workSessions, repositories } = schema;

// ───────── setup checklist (WH-69) ─────────

/**
 * Gathers the rows checklistStatus() needs and computes the team's setup-checklist state. Shared by the
 * team-page banner and the agent briefing so the two can't say different things about what's connected.
 */
export async function checklistForTeam(actor: Actor, teamRef: string): Promise<ChecklistState> {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const [repos, [{ count: sessionCount }], [{ count: activeAgentKeyCount }], [{ count: nodeCount }], [{ count: memberCount }], [{ count: pendingInviteCount }]] =
    await Promise.all([
      db.select({ provider: repositories.provider, lifecycle: repositories.lifecycle }).from(repositories).where(eq(repositories.teamId, team.id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(workSessions)
        .where(eq(workSessions.teamId, team.id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.apiKeys)
        .innerJoin(schema.apiKeyTeams, eq(schema.apiKeyTeams.apiKeyId, schema.apiKeys.id))
        .where(and(eq(schema.apiKeyTeams.teamId, team.id), isNull(schema.apiKeys.revokedAt))),
      db.select({ count: sql<number>`count(*)::int` }).from(nodes).where(eq(nodes.teamId, team.id)),
      db.select({ count: sql<number>`count(*)::int` }).from(schema.memberships).where(eq(schema.memberships.workspaceId, team.workspaceId)),
      db
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
  return checklistStatus({
    teamKey: team.key,
    repositories: repos,
    sessionCount,
    activeAgentKeyCount,
    nodeCount,
    memberCount,
    pendingInviteCount,
  });
}
