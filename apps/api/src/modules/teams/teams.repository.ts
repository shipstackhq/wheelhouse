import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../../db";
import type { TeamRole, WorkspaceRole } from "../../db/schema";
import { Database } from "../../platform/database/database";

const { teams, statuses, events, projects, issues, teamMembers: pm, memberships, users, apiKeyTeams, auditEvents } = schema;

export type TeamRow = typeof teams.$inferSelect;
export type StatusRow = typeof statuses.$inferSelect;
export type AuditInsert = typeof auditEvents.$inferInsert;

/**
 * Every query on the teams area's tables (teams, team members, statuses, the access audit log, and the key scopes that belong to a
 * team), and the only file in the module that touches Drizzle. Each method reads `this.db.q`, so it runs on the current transaction
 * when the service opened one. It decides nothing: the rules are in the services.
 */
@Injectable()
export class TeamsRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── teams ─────────

  listTeams(workspaceId: string, visible: string[] | null, includeRetired: boolean) {
    return this.db.q
      .select()
      .from(teams)
      .where(and(eq(teams.workspaceId, workspaceId), visible ? inArray(teams.id, visible) : undefined, includeRetired ? undefined : isNull(teams.retiredAt)))
      .orderBy(asc(teams.createdAt));
  }

  /** A team of the workspace by uuid or by key (any case). */
  async findTeam(workspaceId: string, ref: { id: string } | { key: string }): Promise<TeamRow | undefined> {
    const [p] = await this.db.q
      .select()
      .from(teams)
      .where(and(eq(teams.workspaceId, workspaceId), "id" in ref ? eq(teams.id, ref.id) : eq(sql`upper(${teams.key})`, ref.key.toUpperCase())));
    return p;
  }

  async teamById(id: string): Promise<TeamRow | undefined> {
    const [p] = await this.db.q.select().from(teams).where(eq(teams.id, id));
    return p;
  }

  async keyTaken(workspaceId: string, key: string): Promise<boolean> {
    const rows = await this.db.q.select({ id: teams.id }).from(teams).where(and(eq(teams.workspaceId, workspaceId), eq(teams.key, key)));
    return rows.length > 0;
  }

  async insertTeam(values: typeof teams.$inferInsert): Promise<TeamRow> {
    const [p] = await this.db.q.insert(teams).values(values).returning();
    return p;
  }

  async updateTeam(id: string, set: Partial<typeof teams.$inferInsert>): Promise<TeamRow> {
    const [row] = await this.db.q.update(teams).set(set).where(eq(teams.id, id)).returning();
    return row;
  }

  async deleteTeam(id: string) {
    await this.db.q.delete(teams).where(eq(teams.id, id));
  }

  /** Lock the workspace's team rows for the rest of the transaction, so two lifecycle changes to its teams run one after the other. */
  async lockWorkspaceTeams(workspaceId: string) {
    await this.db.q.execute(sql`select id from ${teams} where ${teams.workspaceId} = ${workspaceId} for update`);
  }

  /** Lock one team's row for the rest of the transaction. */
  async lockTeam(teamId: string) {
    await this.db.q.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update");
  }

  async countOtherActiveTeams(team: TeamRow): Promise<number> {
    const [r] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(teams).where(and(eq(teams.workspaceId, team.workspaceId), isNull(teams.retiredAt), ne(teams.id, team.id)));
    return Number(r.n);
  }

  /** The team's children by name; only the active ones when `activeOnly`. */
  childTeams(team: TeamRow, activeOnly: boolean) {
    return this.db.q
      .select({ id: teams.id, key: teams.key, name: teams.name })
      .from(teams)
      .where(and(eq(teams.workspaceId, team.workspaceId), eq(teams.parentId, team.id), activeOnly ? isNull(teams.retiredAt) : undefined))
      .orderBy(asc(teams.name));
  }

  childRows(team: TeamRow) {
    return this.db.q.select().from(teams).where(and(eq(teams.workspaceId, team.workspaceId), eq(teams.parentId, team.id))).orderBy(asc(teams.name));
  }

  async parentIdOf(teamId: string): Promise<string | null> {
    const [up] = await this.db.q.select({ parentId: teams.parentId }).from(teams).where(eq(teams.id, teamId));
    return up?.parentId ?? null;
  }

  async idAndKey(teamId: string) {
    const [row] = await this.db.q.select({ id: teams.id, key: teams.key }).from(teams).where(eq(teams.id, teamId));
    return row;
  }

  /** The workspace's teams among `ids`, by name. */
  teamsAmong(workspaceId: string, ids: string[]) {
    return this.db.q.select().from(teams).where(and(eq(teams.workspaceId, workspaceId), inArray(teams.id, ids))).orderBy(asc(teams.name));
  }

  parentLinks(workspaceId: string) {
    return this.db.q.select({ id: teams.id, parentId: teams.parentId }).from(teams).where(eq(teams.workspaceId, workspaceId));
  }

  workspaceTeamsByCreation(workspaceId: string) {
    return this.db.q.select().from(teams).where(eq(teams.workspaceId, workspaceId)).orderBy(teams.createdAt);
  }

  // ───────── projects and events a team leaves behind ─────────

  liveProjectNamesLedBy(teamId: string) {
    return this.db.q.select({ name: projects.name }).from(projects).where(and(eq(projects.leadTeamId, teamId), isNull(projects.deletedAt)));
  }

  async deleteProjectsLedBy(teamId: string) {
    const led = await this.db.q.select({ id: projects.id }).from(projects).where(eq(projects.leadTeamId, teamId));
    if (led.length) await this.db.q.delete(projects).where(inArray(projects.id, led.map((x) => x.id)));
  }

  /** events has no foreign key to teams, so a deleted team's events are cleared explicitly. */
  async deleteEventsOf(teamId: string) {
    await this.db.q.delete(events).where(eq(events.teamId, teamId));
  }

  // ───────── members ─────────

  /** The place a person has put each of their teams in (null when they have not placed it). */
  memberPositions(userId: string, workspaceId: string) {
    return this.db.q.select({ teamId: pm.teamId, position: pm.position }).from(pm).where(and(eq(pm.userId, userId), eq(pm.workspaceId, workspaceId)));
  }

  async setMemberPosition(teamId: string, userId: string, workspaceId: string, position: number) {
    await this.db.q.update(pm).set({ position }).where(and(eq(pm.teamId, teamId), eq(pm.userId, userId), eq(pm.workspaceId, workspaceId)));
  }

  /** The person's role row on the team, by membership only. */
  async memberRole(teamId: string, userId: string): Promise<{ role: TeamRole } | undefined> {
    const [row] = await this.db.q.select({ role: pm.role }).from(pm).where(and(eq(pm.teamId, teamId), eq(pm.userId, userId)));
    return row;
  }

  async adminCount(teamId: string): Promise<number> {
    const [r] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(pm).where(and(eq(pm.teamId, teamId), eq(pm.role, "admin")));
    return Number(r.n);
  }

  async insertMember(values: typeof pm.$inferInsert) {
    await this.db.q.insert(pm).values(values);
  }

  async setMemberRole(teamId: string, userId: string, role: TeamRole) {
    await this.db.q.update(pm).set({ role }).where(and(eq(pm.teamId, teamId), eq(pm.userId, userId)));
  }

  async deleteMember(teamId: string, userId: string) {
    await this.db.q.delete(pm).where(and(eq(pm.teamId, teamId), eq(pm.userId, userId)));
  }

  teamMembers(teamId: string) {
    return this.db.q
      .select({ userId: users.id, name: users.name, email: users.email, role: pm.role, workspaceRole: memberships.role, addedAt: pm.createdAt })
      .from(pm)
      .innerJoin(users, eq(users.id, pm.userId))
      .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
      .where(eq(pm.teamId, teamId))
      .orderBy(pm.createdAt);
  }

  /** Workspace members who are not in the team yet. */
  addableMembers(workspaceId: string, teamId: string) {
    return this.db.q
      .select({ userId: users.id, name: users.name, email: users.email, workspaceRole: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, workspaceId), sql`not exists (select 1 from ${pm} where ${pm.teamId} = ${teamId} and ${pm.userId} = ${memberships.userId})`))
      .orderBy(users.name);
  }

  /** Every membership row of the workspace's teams, with the member's name. */
  workspaceMemberRows(workspaceId: string) {
    return this.db.q
      .select({ teamId: pm.teamId, userId: pm.userId, role: pm.role, name: users.name })
      .from(pm)
      .innerJoin(users, eq(users.id, pm.userId))
      .where(eq(pm.workspaceId, workspaceId));
  }

  // ───────── access ─────────

  async scopedTeamIds(apiKeyId: string, workspaceId: string): Promise<string[]> {
    const rows = await this.db.q.select({ id: apiKeyTeams.teamId }).from(apiKeyTeams).where(and(eq(apiKeyTeams.apiKeyId, apiKeyId), eq(apiKeyTeams.workspaceId, workspaceId)));
    return rows.map((r) => r.id);
  }

  async keyIsScopedTo(apiKeyId: string, teamId: string, workspaceId: string): Promise<boolean> {
    const [row] = await this.db.q
      .select({ id: apiKeyTeams.teamId })
      .from(apiKeyTeams)
      .where(and(eq(apiKeyTeams.apiKeyId, apiKeyId), eq(apiKeyTeams.teamId, teamId), eq(apiKeyTeams.workspaceId, workspaceId)));
    return !!row;
  }

  async scopeKeyTo(apiKeyId: string, teamId: string, workspaceId: string) {
    await this.db.q.insert(apiKeyTeams).values({ apiKeyId, teamId, workspaceId });
  }

  /** The person's team role and workspace role on one team; the membership join drops anyone removed from the workspace. */
  async roleRow(teamId: string, userId: string, workspaceId: string): Promise<{ role: TeamRole; workspaceRole: WorkspaceRole } | undefined> {
    const [row] = await this.db.q
      .select({ role: pm.role, workspaceRole: memberships.role })
      .from(pm)
      .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
      .where(and(eq(pm.teamId, teamId), eq(pm.userId, userId), eq(pm.workspaceId, workspaceId)));
    return row;
  }

  /** The person's team role and workspace role in each team they are on. */
  roleRows(userId: string, workspaceId: string) {
    return this.db.q
      .select({ id: pm.teamId, role: pm.role, workspaceRole: memberships.role })
      .from(pm)
      .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
      .where(and(eq(pm.userId, userId), eq(pm.workspaceId, workspaceId)));
  }

  async workspaceRoleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const [m] = await this.db.q.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
    return m?.role ?? null;
  }

  /** The ids of the active (not retired) teams a person is on. */
  async activeTeamIdsOf(workspaceId: string, userId: string): Promise<string[]> {
    const rows = await this.db.q
      .select({ id: pm.teamId })
      .from(pm)
      .innerJoin(teams, and(eq(teams.id, pm.teamId), eq(teams.workspaceId, pm.workspaceId)))
      .where(and(eq(pm.userId, userId), eq(pm.workspaceId, workspaceId), isNull(teams.retiredAt)));
    return rows.map((r) => r.id);
  }

  // ───────── audit log ─────────

  async insertAudit(values: AuditInsert) {
    await this.db.q.insert(auditEvents).values(values);
  }

  auditRows(workspaceId: string, teamId: string | undefined, limit: number) {
    return this.db.q
      .select({ a: auditEvents, key: teams.key })
      .from(auditEvents)
      .leftJoin(teams, eq(teams.id, auditEvents.teamId))
      .where(and(eq(auditEvents.workspaceId, workspaceId), teamId ? eq(auditEvents.teamId, teamId) : undefined))
      .orderBy(desc(auditEvents.seq))
      .limit(limit);
  }

  // ───────── statuses ─────────

  async insertDefaultStatuses(team: TeamRow, defs: { name: string; role: StatusRow["role"] }[]) {
    await this.db.q.insert(statuses).values(defs.map((c, i) => ({ teamId: team.id, workspaceId: team.workspaceId, name: c.name, role: c.role, isDefault: true, position: i + 1 })));
  }

  statusRows(teamId: string): Promise<StatusRow[]> {
    return this.db.q.select().from(statuses).where(eq(statuses.teamId, teamId)).orderBy(asc(statuses.position), asc(statuses.id));
  }

  /** How many issues each status of the team holds (statuses with none are absent). */
  issueCountsByStatus(teamId: string) {
    return this.db.q.select({ id: issues.statusId, n: sql<number>`count(*)::int` }).from(issues).where(eq(issues.teamId, teamId)).groupBy(issues.statusId);
  }

  async issueCountIn(statusId: string): Promise<number> {
    const [r] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(issues).where(eq(issues.statusId, statusId));
    return Number(r?.n ?? 0);
  }

  async insertStatus(values: typeof statuses.$inferInsert): Promise<StatusRow> {
    const [row] = await this.db.q.insert(statuses).values(values).returning();
    return row;
  }

  async updateStatus(id: string, set: Partial<StatusRow>): Promise<StatusRow> {
    const [row] = await this.db.q.update(statuses).set(set).where(eq(statuses.id, id)).returning();
    return row;
  }

  /** Only one status of a role may be the default at any moment, so the old one is cleared first. */
  async clearDefaultStatus(teamId: string, role: StatusRow["role"]) {
    await this.db.q.update(statuses).set({ isDefault: false }).where(sql`${statuses.teamId} = ${teamId} and ${statuses.role} = ${role} and ${statuses.isDefault}`);
  }

  async setStatusPosition(id: string, position: number) {
    await this.db.q.update(statuses).set({ position }).where(eq(statuses.id, id));
  }

  async makeStatusDefault(id: string) {
    await this.db.q.update(statuses).set({ isDefault: true }).where(eq(statuses.id, id));
  }

  async deleteStatus(id: string) {
    await this.db.q.delete(statuses).where(eq(statuses.id, id));
  }

  /** Moves every issue of one status to another, after what is already there and in the order they had; their version goes up. */
  async moveIssues(fromStatusId: string, toStatusId: string) {
    const [edge] = await this.db.q
      .select({ top: sql<number>`coalesce(max(${issues.position}), 0)`, low: sql<number>`coalesce((select min(position) from issues where status_id = ${fromStatusId}), 0)` })
      .from(issues)
      .where(eq(issues.statusId, toStatusId));
    const shift = Number(edge.top) - Number(edge.low) + 1000;
    await this.db.q.execute(sql`update issues set status_id = ${toStatusId}, position = position + ${shift}, version = version + 1, updated_at = now() where status_id = ${fromStatusId}`);
  }
}
