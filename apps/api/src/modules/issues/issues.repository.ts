import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { teams, statuses, issues, comments, nodes, issueNodes, events, labels, issueLabels, teamMembers, users, teamAgents, workspaceAgents } = schema;

export type IssueRow = typeof issues.$inferSelect;
export type IssueInsert = typeof issues.$inferInsert;
export type TeamRow = typeof teams.$inferSelect;
export type StatusRow = typeof statuses.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type EventRow = typeof events.$inferSelect;
type TeamRef = { id: string; workspaceId: string };

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : ((res as { rows?: T[] }).rows ?? [])) as T[];

/**
 * Every query on the tables of issues (issues, comments, labels, issue_labels, issue_nodes) and on the rows an issue reads next to them
 * (its team and the team's statuses, the map nodes it links to, the team's members, the event log). The only file of the issues
 * service that touches Drizzle. Each method reads the current handle, so it runs on the transaction a service opened. It decides nothing.
 */
@Injectable()
export class IssuesRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── issues ─────────

  claimedIssues(teamId: string) {
    return this.db.q.select().from(issues).where(and(eq(issues.teamId, teamId), sql`${issues.claimedByKeyId} is not null`));
  }

  /** When the actor last did something to the entity, or undefined. */
  async lastEventAt(entityId: string, actorId: string): Promise<Date | undefined> {
    const [last] = await this.db.q
      .select({ at: events.createdAt })
      .from(events)
      .where(and(eq(events.entityId, entityId), eq(events.actorId, actorId)))
      .orderBy(desc(events.seq))
      .limit(1);
    return last?.at;
  }

  async releaseClaim(id: string, version: number) {
    await this.db.q.update(issues).set({ claimedByKeyId: null, version, updatedAt: new Date() }).where(eq(issues.id, id));
  }

  issuesOf(teamId: string) {
    return this.db.q.select().from(issues).where(eq(issues.teamId, teamId)).orderBy(asc(issues.position));
  }

  /** The issue and its team, by id or by the team's key and the issue's number, inside a workspace. */
  async findWithTeam(workspaceId: string, by: { id: string } | { teamKey: string; number: number }): Promise<{ t: IssueRow; p: TeamRow } | undefined> {
    const [row] = await this.db.q
      .select({ t: issues, p: teams })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(
        "id" in by
          ? and(eq(issues.id, by.id), eq(teams.workspaceId, workspaceId))
          : and(eq(teams.workspaceId, workspaceId), eq(teams.key, by.teamKey), eq(issues.number, by.number)),
      );
    return row;
  }

  /** The issue as it is now, read under a row lock for the rest of the transaction; the given row when it is gone. */
  /** The workspace agent with this slug on the team's roster, or undefined. */
  async rosterAgentId(teamId: string, slug: string): Promise<string | undefined> {
    const [r] = await this.db.q
      .select({ id: workspaceAgents.id })
      .from(teamAgents)
      .innerJoin(workspaceAgents, and(eq(workspaceAgents.id, teamAgents.workspaceAgentId), eq(workspaceAgents.workspaceId, teamAgents.workspaceId)))
      .where(and(eq(teamAgents.teamId, teamId), eq(workspaceAgents.slug, slug)));
    return r?.id;
  }

  async lockIssue(row: IssueRow): Promise<IssueRow> {
    const [fresh] = await this.db.q.select().from(issues).where(eq(issues.id, row.id)).for("update");
    return fresh ?? row;
  }

  /** The next number of the team's issues. */
  async nextNumber(teamId: string): Promise<number> {
    const [{ issueCounter }] = await this.db.q
      .update(teams)
      .set({ issueCounter: sql`${teams.issueCounter} + 1` })
      .where(eq(teams.id, teamId))
      .returning({ issueCounter: teams.issueCounter });
    return issueCounter;
  }

  async insertIssue(values: IssueInsert): Promise<IssueRow> {
    const [t] = await this.db.q.insert(issues).values(values).returning();
    return t;
  }

  async updateIssue(id: string, set: Partial<IssueInsert>): Promise<IssueRow> {
    const [row] = await this.db.q.update(issues).set(set).where(eq(issues.id, id)).returning();
    return row;
  }

  async deleteIssue(id: string) {
    await this.db.q.delete(issues).where(eq(issues.id, id));
  }

  /** The other issues of a status, in order, to find a position among. */
  siblingsInStatus(statusId: string, excludeId?: string) {
    return this.db.q
      .select({ id: issues.id, position: issues.position })
      .from(issues)
      .where(and(eq(issues.statusId, statusId), excludeId ? ne(issues.id, excludeId) : undefined))
      .orderBy(asc(issues.position));
  }

  // ───────── statuses and the team ─────────

  statusesOf(teamId: string) {
    return this.db.q.select().from(statuses).where(eq(statuses.teamId, teamId)).orderBy(asc(statuses.position));
  }

  async statusById(id: string): Promise<StatusRow | undefined> {
    const [col] = await this.db.q.select().from(statuses).where(eq(statuses.id, id));
    return col;
  }

  async isTeamMember(teamId: string, userId: string): Promise<boolean> {
    const [m] = await this.db.q
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return !!m;
  }

  /** The team's row, locked for the rest of the transaction: two people re-parenting issues take turns. */
  async lockTeam(teamId: string) {
    await this.db.q.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update");
  }

  boardNodes(teamId: string) {
    return this.db.q
      .select({ id: nodes.id, name: nodes.name, kind: nodes.kind, parentId: nodes.parentId, layer: nodes.layer })
      .from(nodes)
      .where(eq(nodes.teamId, teamId));
  }

  teamMembersOf(teamId: string) {
    return this.db.q
      .select({ id: users.id, name: users.name })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId));
  }

  // ───────── comments, history, linked nodes ─────────

  commentsOf(issueId: string) {
    return this.db.q.select().from(comments).where(eq(comments.issueId, issueId)).orderBy(asc(comments.createdAt));
  }

  async insertComment(values: typeof comments.$inferInsert): Promise<CommentRow> {
    const [c] = await this.db.q.insert(comments).values(values).returning();
    return c;
  }

  commentCounts(issueIds: string[]) {
    return this.db.q
      .select({ issueId: comments.issueId, n: sql<number>`count(*)::int` })
      .from(comments)
      .where(inArray(comments.issueId, issueIds))
      .groupBy(comments.issueId);
  }

  historyOf(teamId: string, issueId: string) {
    return this.db.q.select().from(events).where(and(eq(events.teamId, teamId), eq(events.entityId, issueId))).orderBy(desc(events.seq)).limit(50);
  }

  nodeLinksOf(issueIds: string[]) {
    return this.db.q.select().from(issueNodes).where(inArray(issueNodes.issueId, issueIds));
  }

  linkedNodes(issueId: string) {
    return this.db.q
      .select({ id: nodes.id, name: nodes.name, kind: nodes.kind, parentId: nodes.parentId })
      .from(issueNodes)
      .innerJoin(nodes, eq(nodes.id, issueNodes.nodeId))
      .where(eq(issueNodes.issueId, issueId));
  }

  async linkNode(issueId: string, nodeId: string) {
    await this.db.q.insert(issueNodes).values({ issueId, nodeId }).onConflictDoNothing();
  }

  async unlinkNode(issueId: string, nodeId: string) {
    await this.db.q.delete(issueNodes).where(and(eq(issueNodes.issueId, issueId), eq(issueNodes.nodeId, nodeId)));
  }

  // ───────── labels ─────────

  /** The label names on each issue, alphabetical (the join has no order of its own). */
  labelRows(issueIds: string[]) {
    return this.db.q
      .select({ issueId: issueLabels.issueId, name: labels.name })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(inArray(issueLabels.issueId, issueIds))
      .orderBy(asc(sql`lower(${labels.name})`));
  }

  /** Make an issue carry exactly these label names, creating the team's labels that do not exist yet (a name matches in any case). */
  async setLabels(team: TeamRef, issueId: string, names: string[]) {
    const q = this.db.q;
    if (names.length) {
      await q
        .insert(labels)
        .values(names.map((name) => ({ teamId: team.id, workspaceId: team.workspaceId, name })))
        .onConflictDoNothing();
    }
    const rows = names.length
      ? await q
          .select({ id: labels.id })
          .from(labels)
          .where(and(eq(labels.teamId, team.id), inArray(sql`lower(${labels.name})`, names.map((n) => n.toLowerCase()))))
      : [];
    const ids = rows.map((r) => r.id);
    await q.delete(issueLabels).where(and(eq(issueLabels.issueId, issueId), ids.length ? notInArray(issueLabels.labelId, ids) : undefined));
    if (ids.length) {
      await q
        .insert(issueLabels)
        .values(ids.map((labelId) => ({ issueId, labelId, teamId: team.id, workspaceId: team.workspaceId })))
        .onConflictDoNothing();
    }
  }

  // ───────── sub-issues ─────────

  async parentById(teamId: string, id: string): Promise<{ id: string; number: number } | undefined> {
    const [parent] = await this.db.q.select({ id: issues.id, number: issues.number }).from(issues).where(and(eq(issues.id, id), eq(issues.teamId, teamId)));
    return parent;
  }

  async parentByNumber(teamId: string, number: number): Promise<{ id: string; number: number } | undefined> {
    const [parent] = await this.db.q.select({ id: issues.id, number: issues.number }).from(issues).where(and(eq(issues.teamId, teamId), eq(issues.number, number)));
    return parent;
  }

  /** The levels from `id` up to its top-level issue, counting `id` itself (1 for an issue with no parent). One recursive query up the chain. */
  async depthAbove(id: string, limit: number): Promise<number> {
    const res = await this.db.q.execute(sql`
      with recursive up(id, parent_id, depth) as (
        select id, parent_id, 1 from issues where id = ${id}::uuid
        union all
        select i.id, i.parent_id, up.depth + 1 from issues i join up on i.id = up.parent_id where up.depth < ${limit}
      )
      select max(depth)::int as depth from up`);
    return rowsOf<{ depth: number | null }>(res)[0]?.depth ?? 0;
  }

  /** The levels from `id` down to its deepest sub-issue, counting `id` itself (1 for an issue with no sub-issues). */
  async heightBelow(id: string, limit: number): Promise<number> {
    const res = await this.db.q.execute(sql`
      with recursive down(id, depth) as (
        select id, 1 from issues where id = ${id}::uuid
        union all
        select i.id, down.depth + 1 from issues i join down on i.parent_id = down.id where down.depth < ${limit}
      )
      select max(depth)::int as depth from down`);
    return rowsOf<{ depth: number | null }>(res)[0]?.depth ?? 1;
  }

  /** Whether `ancestor` is `id` or sits somewhere above it. */
  async isSelfOrAncestor(ancestor: string, id: string, limit: number): Promise<boolean> {
    const res = await this.db.q.execute(sql`
      with recursive up(id, parent_id, depth) as (
        select id, parent_id, 1 from issues where id = ${id}::uuid
        union all
        select i.id, i.parent_id, up.depth + 1 from issues i join up on i.id = up.parent_id where up.depth < ${limit}
      )
      select 1 as hit from up where id = ${ancestor}::uuid limit 1`);
    return rowsOf(res).length > 0;
  }

  /** An issue with the name and role of its status, so progress can be shown. */
  async withStatus(id: string) {
    const [row] = await this.db.q.select(this.relativeColumns).from(issues).innerJoin(statuses, eq(statuses.id, issues.statusId)).where(eq(issues.id, id));
    return row;
  }

  /** The direct sub-issues of an issue (in number order) with the name and role of their status. */
  subIssuesWithStatus(parentId: string) {
    return this.db.q.select(this.relativeColumns).from(issues).innerJoin(statuses, eq(statuses.id, issues.statusId)).where(eq(issues.parentId, parentId)).orderBy(asc(issues.number));
  }

  private readonly relativeColumns = { number: issues.number, title: issues.title, priority: issues.priority, assigneeId: issues.assigneeId, status: statuses.name, role: statuses.role };
}
