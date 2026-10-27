import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, getTableColumns } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { workspaceAgents, teamAgents, teams, workspaces, issues } = schema;
const columns = getTableColumns(workspaceAgents);

export type AgentRow = typeof workspaceAgents.$inferSelect & { teamKey: string | null };

/**
 * Every query on the agents tables (workspace_agents, team_agents), and the one read of `workspaces.settings` (the agents switch).
 * It decides nothing; every statement starts from the workspace id the service took from the actor.
 */
@Injectable()
export class AgentsRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  private select() {
    return this.db.q.select({ ...columns, teamKey: teams.key }).from(workspaceAgents).leftJoin(teams, eq(teams.id, workspaceAgents.teamId));
  }

  async agentsEnabled(workspaceId: string): Promise<boolean> {
    const [w] = await this.db.q.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId));
    return w?.settings.agentsEnabled !== false;
  }

  agentRows(workspaceId: string): Promise<AgentRow[]> {
    return this.select().where(eq(workspaceAgents.workspaceId, workspaceId)).orderBy(asc(workspaceAgents.createdAt));
  }

  async agentBySlug(workspaceId: string, slug: string): Promise<AgentRow | undefined> {
    const [row] = await this.select().where(and(eq(workspaceAgents.workspaceId, workspaceId), eq(workspaceAgents.slug, slug)));
    return row;
  }

  async insertAgent(values: typeof workspaceAgents.$inferInsert) {
    const [row] = await this.db.q.insert(workspaceAgents).values(values).returning();
    return row;
  }

  async updateAgent(id: string, set: Partial<typeof workspaceAgents.$inferInsert>) {
    const [row] = await this.db.q.update(workspaceAgents).set({ ...set, updatedAt: new Date() }).where(eq(workspaceAgents.id, id)).returning();
    return row;
  }

  async deleteAgent(id: string) {
    await this.db.q.delete(workspaceAgents).where(eq(workspaceAgents.id, id));
  }

  /** The team's roster, oldest first, each with the agent row. */
  async roster(teamId: string): Promise<AgentRow[]> {
    return this.db.q
      .select({ ...columns, teamKey: teams.key })
      .from(teamAgents)
      .innerJoin(workspaceAgents, and(eq(workspaceAgents.id, teamAgents.workspaceAgentId), eq(workspaceAgents.workspaceId, teamAgents.workspaceId)))
      .leftJoin(teams, eq(teams.id, workspaceAgents.teamId))
      .where(eq(teamAgents.teamId, teamId))
      .orderBy(asc(teamAgents.createdAt));
  }

  /** The ids of the teams each agent of the workspace is on. */
  rosterTeams(workspaceId: string) {
    return this.db.q.select({ agentId: teamAgents.workspaceAgentId, teamId: teamAgents.teamId }).from(teamAgents).where(eq(teamAgents.workspaceId, workspaceId));
  }

  async addToRoster(team: { id: string; workspaceId: string }, agentId: string, addedBy: string) {
    const rows = await this.db.q.insert(teamAgents).values({ teamId: team.id, workspaceId: team.workspaceId, workspaceAgentId: agentId, addedBy }).onConflictDoNothing().returning();
    return rows.length > 0;
  }

  async removeFromRoster(teamId: string, agentId: string) {
    const rows = await this.db.q.delete(teamAgents).where(and(eq(teamAgents.teamId, teamId), eq(teamAgents.workspaceAgentId, agentId))).returning();
    // An agent off the roster can no longer be the team's delegate (WH-113).
    if (rows.length) await this.db.q.update(issues).set({ delegateAgentId: null }).where(and(eq(issues.teamId, teamId), eq(issues.delegateAgentId, agentId)));
    return rows.length > 0;
  }
}
