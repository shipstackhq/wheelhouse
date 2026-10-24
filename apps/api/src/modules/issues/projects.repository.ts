import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { projects, projectTeams, projectMilestones, projectVisibility, issues, statuses, teams, workspaceEvents, users } = schema;

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type MilestoneRow = typeof projectMilestones.$inferSelect;
export type MilestoneInsert = typeof projectMilestones.$inferInsert;
export type TeamRow = typeof teams.$inferSelect;

const counted = {
  total: sql<number>`count(*) filter (where ${statuses.role} is distinct from 'canceled')::int`,
  done: sql<number>`count(*) filter (where ${statuses.role} = 'done')::int`,
};

/**
 * Every query on the tables of projects (projects, project_teams, project_milestones, the project_visibility view) and on the rows a
 * project counts or names next to them (its issues and their statuses, teams, people, the workspace log). The only file of the projects
 * service that touches Drizzle. Each method reads the current handle, so it runs on the transaction a service opened. It decides nothing.
 */
@Injectable()
export class ProjectsRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── projects ─────────

  /** A live (not deleted) project of the workspace. */
  async findLive(workspaceId: string, id: string): Promise<ProjectRow | undefined> {
    const [project] = await this.db.q.select().from(projects).where(and(eq(projects.id, id), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)));
    return project;
  }

  /** The project as it is now, read under a row lock for the rest of the transaction. */
  async lockProject(id: string): Promise<ProjectRow | undefined> {
    const [row] = await this.db.q.select().from(projects).where(eq(projects.id, id)).for("update");
    return row;
  }

  async insertProject(values: ProjectInsert): Promise<ProjectRow> {
    const [p] = await this.db.q.insert(projects).values(values).returning();
    return p;
  }

  async updateProject(id: string, set: Partial<ProjectInsert>): Promise<ProjectRow> {
    const [u] = await this.db.q.update(projects).set(set).where(eq(projects.id, id)).returning();
    return u;
  }

  async touchProject(id: string) {
    await this.db.q.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
  }

  /** The projects the person sees through `project_visibility`. */
  async visibleTo(workspaceId: string, userId: string): Promise<ProjectRow[]> {
    const rows = await this.db.q
      .select({ p: projects })
      .from(projects)
      .innerJoin(projectVisibility, eq(projectVisibility.projectId, projects.id))
      .where(and(eq(projectVisibility.userId, userId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)));
    return rows.map((r) => r.p);
  }

  /** The ids of every project the person sees (deleted ones included: the view does not know). */
  async visibleIds(userId: string): Promise<string[]> {
    return (await this.db.q.select({ id: projectVisibility.projectId }).from(projectVisibility).where(eq(projectVisibility.userId, userId))).map((r) => r.id);
  }

  /** Id and name of the live projects the person sees. */
  visibleNames(workspaceId: string, userId: string) {
    return this.db.q
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .innerJoin(projectVisibility, eq(projectVisibility.projectId, projects.id))
      .where(and(eq(projectVisibility.userId, userId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)));
  }

  byIds(ids: string[]) {
    return this.db.q.select().from(projects).where(inArray(projects.id, ids));
  }

  namesOf(ids: string[]) {
    return this.db.q.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids));
  }

  // ───────── teams of a project ─────────

  async teamIdsOf(projectId: string): Promise<string[]> {
    return (await this.db.q.select({ id: projectTeams.teamId }).from(projectTeams).where(eq(projectTeams.projectId, projectId))).map((r) => r.id);
  }

  async takesPart(projectId: string, teamId: string): Promise<boolean> {
    const [takes] = await this.db.q.select().from(projectTeams).where(and(eq(projectTeams.projectId, projectId), eq(projectTeams.teamId, teamId)));
    return !!takes;
  }

  async insertTeams(rows: { projectId: string; teamId: string; workspaceId: string }[]) {
    await this.db.q.insert(projectTeams).values(rows);
  }

  async deleteTeam(projectId: string, teamId: string) {
    await this.db.q.delete(projectTeams).where(and(eq(projectTeams.projectId, projectId), eq(projectTeams.teamId, teamId)));
  }

  teamCounts(projectIds: string[]) {
    return this.db.q.select({ projectId: projectTeams.projectId, n: sql<number>`count(*)::int` }).from(projectTeams).where(inArray(projectTeams.projectId, projectIds)).groupBy(projectTeams.projectId);
  }

  /** A team of the workspace by its key (any case). */
  async teamByKey(workspaceId: string, key: string): Promise<TeamRow | undefined> {
    const [t] = await this.db.q.select().from(teams).where(and(eq(teams.workspaceId, workspaceId), sql`lower(${teams.key}) = lower(${key})`));
    return t;
  }

  teamsByIds(ids: string[]) {
    return this.db.q.select({ id: teams.id, key: teams.key, name: teams.name }).from(teams).where(inArray(teams.id, ids));
  }

  usersByIds(ids: string[]) {
    return this.db.q.select({ id: users.id, name: users.name, avatarKey: users.avatarKey }).from(users).where(inArray(users.id, ids));
  }

  // ───────── a project's issues ─────────

  /** Per project: issues in it (a canceled one is not counted) and how many are done. */
  progress(projectIds: string[]) {
    return this.db.q.select({ projectId: issues.projectId, ...counted }).from(issues).innerJoin(statuses, eq(statuses.id, issues.statusId)).where(inArray(issues.projectId, projectIds)).groupBy(issues.projectId);
  }

  /** The same per team, inside one project. */
  progressByTeam(projectId: string) {
    return this.db.q.select({ teamId: issues.teamId, ...counted }).from(issues).innerJoin(statuses, eq(statuses.id, issues.statusId)).where(eq(issues.projectId, projectId)).groupBy(issues.teamId);
  }

  /** The same per milestone, inside one project. */
  progressByMilestone(projectId: string) {
    return this.db.q
      .select({ milestoneId: issues.milestoneId, ...counted })
      .from(issues)
      .innerJoin(statuses, eq(statuses.id, issues.statusId))
      .where(and(eq(issues.projectId, projectId), sql`${issues.milestoneId} is not null`))
      .groupBy(issues.milestoneId);
  }

  /** The project's issues of some teams, in number order, with their status. */
  issuesOfTeams(projectId: string, teamIds: string[]) {
    return this.db.q
      .select({ teamId: issues.teamId, number: issues.number, title: issues.title, priority: issues.priority, status: statuses.name, role: statuses.role, milestoneId: issues.milestoneId })
      .from(issues)
      .innerJoin(statuses, eq(statuses.id, issues.statusId))
      .where(and(eq(issues.projectId, projectId), inArray(issues.teamId, teamIds)))
      .orderBy(asc(issues.number));
  }

  async countTeamIssues(projectId: string, teamId: string): Promise<number> {
    const [{ n }] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(issues).where(and(eq(issues.projectId, projectId), eq(issues.teamId, teamId)));
    return Number(n);
  }

  /** Take the project's issues (all of them, or one team's) out of it and its milestones; returns their ids. */
  async releaseIssues(projectId: string, teamId?: string): Promise<string[]> {
    const rows = await this.db.q
      .update(issues)
      .set({ projectId: null, milestoneId: null, version: sql`${issues.version} + 1`, updatedAt: new Date() })
      .where(and(eq(issues.projectId, projectId), teamId ? eq(issues.teamId, teamId) : undefined))
      .returning({ id: issues.id });
    return rows.map((r) => r.id);
  }

  // ───────── milestones ─────────

  milestonesOf(projectId: string) {
    return this.db.q.select().from(projectMilestones).where(eq(projectMilestones.projectId, projectId)).orderBy(asc(projectMilestones.position), asc(projectMilestones.createdAt));
  }

  async maxMilestonePosition(projectId: string): Promise<number> {
    const [{ max }] = await this.db.q.select({ max: sql<number>`coalesce(max(${projectMilestones.position}), 0)` }).from(projectMilestones).where(eq(projectMilestones.projectId, projectId));
    return Number(max);
  }

  async insertMilestone(values: MilestoneInsert): Promise<MilestoneRow> {
    const [m] = await this.db.q.insert(projectMilestones).values(values).returning();
    return m;
  }

  async findMilestone(projectId: string, id: string): Promise<MilestoneRow | undefined> {
    const [m] = await this.db.q.select().from(projectMilestones).where(and(eq(projectMilestones.id, id), eq(projectMilestones.projectId, projectId)));
    return m;
  }

  milestonePositions(projectId: string) {
    return this.db.q.select({ id: projectMilestones.id, position: projectMilestones.position }).from(projectMilestones).where(eq(projectMilestones.projectId, projectId)).orderBy(asc(projectMilestones.position));
  }

  async updateMilestone(id: string, set: Partial<MilestoneInsert>) {
    await this.db.q.update(projectMilestones).set(set).where(eq(projectMilestones.id, id));
  }

  async deleteMilestone(id: string) {
    await this.db.q.delete(projectMilestones).where(eq(projectMilestones.id, id));
  }

  /** The milestones of some projects, in order. */
  milestonesFor(projectIds: string[]) {
    return this.db.q
      .select({ id: projectMilestones.id, projectId: projectMilestones.projectId, name: projectMilestones.name })
      .from(projectMilestones)
      .where(inArray(projectMilestones.projectId, projectIds))
      .orderBy(asc(projectMilestones.position));
  }

  // ───────── a team's projects ─────────

  /** The live projects a team takes part in, by name. */
  projectsOfTeam(teamId: string) {
    return this.db.q
      .select({ id: projects.id, name: projects.name, status: projects.status })
      .from(projectTeams)
      .innerJoin(projects, eq(projects.id, projectTeams.projectId))
      .where(and(eq(projectTeams.teamId, teamId), isNull(projects.deletedAt)))
      .orderBy(asc(projects.name));
  }

  // ───────── the workspace log ─────────

  async insertWorkspaceEvent(values: typeof workspaceEvents.$inferInsert) {
    await this.db.q.insert(workspaceEvents).values(values);
  }
}
