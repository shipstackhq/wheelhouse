import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { ideas, ideaComments, teams, issues } = schema;

export type IdeaRow = typeof ideas.$inferSelect;
export type IdeaInsert = typeof ideas.$inferInsert;
export type IdeaCommentRow = typeof ideaComments.$inferSelect;

/** Every query on the ideas tables and on the team and issue names shown next to them. It decides nothing. */
@Injectable()
export class IdeasRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** The workspace's ideas, newest first, of one status when given. */
  list(workspaceId: string, status?: schema.IdeaStatus): Promise<IdeaRow[]> {
    return this.db.q
      .select()
      .from(ideas)
      .where(and(eq(ideas.workspaceId, workspaceId), status ? eq(ideas.status, status) : undefined))
      .orderBy(desc(ideas.createdAt), desc(ideas.id));
  }

  async find(workspaceId: string, id: string): Promise<IdeaRow | undefined> {
    const [row] = await this.db.q.select().from(ideas).where(and(eq(ideas.id, id), eq(ideas.workspaceId, workspaceId)));
    return row;
  }

  /** The idea as it is now, under a row lock for the rest of the transaction. */
  async lock(workspaceId: string, id: string): Promise<IdeaRow | undefined> {
    const [row] = await this.db.q.select().from(ideas).where(and(eq(ideas.id, id), eq(ideas.workspaceId, workspaceId))).for("update");
    return row;
  }

  async insert(values: IdeaInsert): Promise<IdeaRow> {
    const [row] = await this.db.q.insert(ideas).values(values).returning();
    return row;
  }

  async update(id: string, set: Partial<IdeaInsert>): Promise<IdeaRow> {
    const [row] = await this.db.q.update(ideas).set({ ...set, updatedAt: new Date() }).where(eq(ideas.id, id)).returning();
    return row;
  }

  commentsOf(ideaId: string): Promise<IdeaCommentRow[]> {
    return this.db.q.select().from(ideaComments).where(eq(ideaComments.ideaId, ideaId)).orderBy(ideaComments.createdAt, ideaComments.id);
  }

  async insertComment(values: typeof ideaComments.$inferInsert): Promise<IdeaCommentRow> {
    const [row] = await this.db.q.insert(ideaComments).values(values).returning();
    return row;
  }

  commentCounts(ideaIds: string[]) {
    if (!ideaIds.length) return Promise.resolve([]);
    return this.db.q.select({ ideaId: ideaComments.ideaId, id: ideaComments.id }).from(ideaComments).where(inArray(ideaComments.ideaId, ideaIds));
  }

  teamsByIds(ids: string[]) {
    if (!ids.length) return Promise.resolve([]);
    return this.db.q.select({ id: teams.id, key: teams.key, name: teams.name }).from(teams).where(inArray(teams.id, ids));
  }

  /** The live issues the ideas were promoted to, with the team key their ref is built from. */
  issuesByIds(ids: string[]) {
    if (!ids.length) return Promise.resolve([]);
    return this.db.q
      .select({ id: issues.id, number: issues.number, title: issues.title, teamKey: teams.key })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(inArray(issues.id, ids));
  }
}
