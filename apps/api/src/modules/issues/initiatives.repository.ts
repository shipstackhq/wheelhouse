import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { initiatives, initiativeProjects, projects, users } = schema;

export type InitiativeRow = typeof initiatives.$inferSelect;
export type InitiativeInsert = typeof initiatives.$inferInsert;

/**
 * Every query on the tables of initiatives (initiatives, initiative_projects) and on the names it shows next to them (the people who own
 * them, the live projects a link points at). The only file of the initiatives service that touches Drizzle. Each method reads the
 * current handle, so it runs on the transaction a service opened. It decides nothing.
 */
@Injectable()
export class InitiativesRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  liveOf(workspaceId: string): Promise<InitiativeRow[]> {
    return this.db.q.select().from(initiatives).where(and(eq(initiatives.workspaceId, workspaceId), isNull(initiatives.deletedAt)));
  }

  async findLive(workspaceId: string, id: string): Promise<InitiativeRow | undefined> {
    const [row] = await this.db.q.select().from(initiatives).where(and(eq(initiatives.id, id), eq(initiatives.workspaceId, workspaceId), isNull(initiatives.deletedAt)));
    return row;
  }

  /** The initiative as it is now, read under a row lock for the rest of the transaction (also a deleted one: the caller says what that means). */
  async lock(id: string): Promise<InitiativeRow | undefined> {
    const [row] = await this.db.q.select().from(initiatives).where(eq(initiatives.id, id)).for("update");
    return row;
  }

  /** Lock the workspace's initiatives so two moves cannot, between them, make a cycle or go past the depth limit. */
  async lockTree(workspaceId: string) {
    await this.db.q.execute(sql`select id from initiatives where workspace_id = ${workspaceId} for update`);
  }

  async insert(values: InitiativeInsert): Promise<InitiativeRow> {
    const [i] = await this.db.q.insert(initiatives).values(values).returning();
    return i;
  }

  async update(id: string, set: Partial<InitiativeInsert>): Promise<InitiativeRow> {
    const [u] = await this.db.q.update(initiatives).set(set).where(eq(initiatives.id, id)).returning();
    return u;
  }

  /** The live projects each initiative links to. */
  linksOf(initiativeIds: string[]) {
    return this.db.q
      .select({ initiativeId: initiativeProjects.initiativeId, projectId: initiativeProjects.projectId })
      .from(initiativeProjects)
      .innerJoin(projects, eq(projects.id, initiativeProjects.projectId))
      .where(and(inArray(initiativeProjects.initiativeId, initiativeIds), isNull(projects.deletedAt)));
  }

  async hasLink(initiativeId: string, projectId: string): Promise<boolean> {
    const [already] = await this.db.q.select().from(initiativeProjects).where(and(eq(initiativeProjects.initiativeId, initiativeId), eq(initiativeProjects.projectId, projectId)));
    return !!already;
  }

  async insertLink(values: { initiativeId: string; projectId: string; workspaceId: string }) {
    await this.db.q.insert(initiativeProjects).values(values);
  }

  /** Remove the links of an initiative (to one project, or to all); returns the project ids. */
  async deleteLinks(initiativeId: string, projectId?: string): Promise<string[]> {
    const rows = await this.db.q
      .delete(initiativeProjects)
      .where(and(eq(initiativeProjects.initiativeId, initiativeId), projectId ? eq(initiativeProjects.projectId, projectId) : undefined))
      .returning({ id: initiativeProjects.projectId });
    return rows.map((r) => r.id);
  }

  namesOfUsers(ids: string[]) {
    return this.db.q.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  }
}
