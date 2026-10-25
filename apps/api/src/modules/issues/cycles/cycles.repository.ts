import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { schema } from "../../../db";
import { Database } from "../../../platform/database/database";

const { cycles, issues, statuses, events, teams } = schema;

export type CycleRow = typeof cycles.$inferSelect;
export type CycleInsert = typeof cycles.$inferInsert;

/**
 * Every query on `cycles`, and on the issues, statuses and events a cycle counts, moves or reports. The only file of the cycles service
 * that touches Drizzle. Each method reads the current handle, so it runs on the transaction a service opened. It decides nothing.
 */
@Injectable()
export class CyclesRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Lock the team's row for the rest of the transaction, so two people cannot both create overlapping cycles. */
  async lockTeam(teamId: string) {
    await this.db.q.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update");
  }

  async teamKey(teamId: string): Promise<string> {
    const [team] = await this.db.q.select({ key: teams.key }).from(teams).where(eq(teams.id, teamId));
    return team.key;
  }

  async findByNumber(teamId: string, number: number): Promise<CycleRow | undefined> {
    const [c] = Number.isSafeInteger(number) ? await this.db.q.select().from(cycles).where(and(eq(cycles.teamId, teamId), eq(cycles.number, number))) : [];
    return c;
  }

  /** A cycle of the team that overlaps the window, if any. */
  async overlapping(teamId: string, startsAt: Date, endsAt: Date, exceptId?: string): Promise<CycleRow | undefined> {
    const [hit] = await this.db.q
      .select()
      .from(cycles)
      .where(and(eq(cycles.teamId, teamId), lt(cycles.startsAt, endsAt), gt(cycles.endsAt, startsAt), exceptId ? ne(cycles.id, exceptId) : undefined))
      .limit(1);
    return hit;
  }

  async maxNumber(teamId: string): Promise<number> {
    const [{ max }] = await this.db.q.select({ max: sql<number>`coalesce(max(${cycles.number}), 0)::int` }).from(cycles).where(eq(cycles.teamId, teamId));
    return Number(max);
  }

  async insertCycle(values: CycleInsert): Promise<CycleRow> {
    const [c] = await this.db.q.insert(cycles).values(values).returning();
    return c;
  }

  async updateCycle(id: string, set: Partial<CycleInsert>): Promise<CycleRow> {
    const [u] = await this.db.q.update(cycles).set(set).where(eq(cycles.id, id)).returning();
    return u;
  }

  async deleteCycle(id: string) {
    await this.db.q.delete(cycles).where(eq(cycles.id, id));
  }

  listOf(teamId: string) {
    return this.db.q.select().from(cycles).where(eq(cycles.teamId, teamId)).orderBy(asc(cycles.startsAt));
  }

  /** The newest cycles of a team, latest start first. */
  newest(teamId: string, limit: number) {
    return this.db.q.select().from(cycles).where(eq(cycles.teamId, teamId)).orderBy(sql`${cycles.startsAt} desc`).limit(limit);
  }

  async numbersOf(ids: string[]) {
    return this.db.q.select({ id: cycles.id, number: cycles.number }).from(cycles).where(inArray(cycles.id, ids));
  }

  // ───────── counts and rollover ─────────

  /** Per cycle: issues in it (a canceled one is not counted) and how many are done. */
  counts(cycleIds: string[]) {
    return this.db.q
      .select({
        cycleId: issues.cycleId,
        total: sql<number>`count(*) filter (where ${statuses.role} is distinct from 'canceled')::int`,
        done: sql<number>`count(*) filter (where ${statuses.role} = 'done')::int`,
      })
      .from(issues)
      .innerJoin(statuses, eq(statuses.id, issues.statusId))
      .where(inArray(issues.cycleId, cycleIds))
      .groupBy(issues.cycleId);
  }

  /** The id of one cycle of the team that has ended and not been rolled over, if any. */
  async pendingRollover(teamId: string, now: Date): Promise<string | undefined> {
    const [pending] = await this.db.q.select({ id: cycles.id }).from(cycles).where(and(eq(cycles.teamId, teamId), lte(cycles.endsAt, now), isNull(cycles.rolledOverAt))).limit(1);
    return pending?.id;
  }

  endedNotRolledOver(teamId: string, now: Date) {
    return this.db.q.select().from(cycles).where(and(eq(cycles.teamId, teamId), lte(cycles.endsAt, now), isNull(cycles.rolledOverAt))).orderBy(asc(cycles.startsAt));
  }

  /** The issues of a cycle that are in no done or canceled status. */
  unfinishedIssues(cycleId: string) {
    return this.db.q
      .select({ id: issues.id, number: issues.number, version: issues.version })
      .from(issues)
      .innerJoin(statuses, eq(statuses.id, issues.statusId))
      .where(and(eq(issues.cycleId, cycleId), sql`coalesce(${statuses.role}, '') not in ('done', 'canceled')`));
  }

  /** The team's next cycle by start, from a moment on. */
  async firstStartingFrom(teamId: string, from: Date): Promise<CycleRow | undefined> {
    const [next] = await this.db.q.select().from(cycles).where(and(eq(cycles.teamId, teamId), gte(cycles.startsAt, from))).orderBy(asc(cycles.startsAt)).limit(1);
    return next;
  }

  async moveIssuesToCycle(issueIds: string[], cycleId: string, now: Date) {
    await this.db.q.update(issues).set({ cycleId, version: sql`${issues.version} + 1`, updatedAt: now }).where(inArray(issues.id, issueIds));
  }

  async markRolledOver(id: string, now: Date) {
    await this.db.q.update(cycles).set({ rolledOverAt: now }).where(eq(cycles.id, id));
  }

  // ───────── reading a cycle ─────────

  async issueCount(cycleId: string): Promise<number> {
    const [{ n }] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(issues).where(eq(issues.cycleId, cycleId));
    return Number(n);
  }

  issuesInCycle(cycleId: string) {
    return this.db.q
      .select({ number: issues.number, title: issues.title, priority: issues.priority, status: statuses.name, role: statuses.role, assigneeId: issues.assigneeId })
      .from(issues)
      .innerJoin(statuses, eq(statuses.id, issues.statusId))
      .where(eq(issues.cycleId, cycleId))
      .orderBy(asc(issues.number));
  }

  // ───────── what landed ─────────

  async doneStatusNames(teamId: string): Promise<Set<string>> {
    return new Set((await this.db.q.select({ name: statuses.name }).from(statuses).where(and(eq(statuses.teamId, teamId), eq(statuses.role, "done")))).map((c) => c.name));
  }

  /** The `issue.moved` events of a team in [from, to), oldest first. */
  moveEvents(teamId: string, from: Date, to: Date) {
    return this.db.q
      .select()
      .from(events)
      .where(and(eq(events.teamId, teamId), eq(events.type, "issue.moved"), gte(events.createdAt, from), lt(events.createdAt, to)))
      .orderBy(asc(events.seq));
  }

  issuesByIds(ids: string[]) {
    return this.db.q.select({ id: issues.id, title: issues.title, cycleId: issues.cycleId, number: issues.number }).from(issues).where(inArray(issues.id, ids));
  }
}
