import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { nodes, events, docs, docDrafts, docNodes, apiKeys, users, memberships } = schema;

export type DocRow = typeof docs.$inferSelect;
export type DocDraftRow = typeof docDrafts.$inferSelect;

/**
 * Every query on the docs area's tables (docs, doc nodes, doc drafts, and the reads the page needs from keys, users, memberships, nodes and the
 * event log), and the only file in the module that touches Drizzle. Each method reads `this.db.q`, so it runs on the current transaction
 * when the service opened one. It decides nothing: the rules are in the service.
 */
@Injectable()
export class DocsRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── keys, users, memberships ─────────

  /** The capabilities of an agent key, or undefined when there is no such key. */
  async keyCapabilities(keyId: string): Promise<string[] | undefined> {
    const [key] = await this.db.q.select({ capabilities: apiKeys.capabilities }).from(apiKeys).where(eq(apiKeys.id, keyId));
    return key?.capabilities;
  }

  /** The people of a workspace, by id and name. */
  workspaceMembers(workspaceId: string) {
    return this.db.q
      .select({ id: users.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, workspaceId));
  }

  async userName(id: string): Promise<string | undefined> {
    const [owner] = await this.db.q.select({ name: users.name }).from(users).where(eq(users.id, id));
    return owner?.name;
  }

  // ───────── map nodes (read by the docs; resolved by the map module's service) ─────────

  nodesLinkedTo(docId: string) {
    return this.db.q.select({ id: nodes.id, name: nodes.name, kind: nodes.kind, layer: nodes.layer }).from(docNodes).innerJoin(nodes, eq(nodes.id, docNodes.nodeId)).where(eq(docNodes.docId, docId));
  }

  linkedNodeIds(docId: string) {
    return this.db.q.select({ nodeId: docNodes.nodeId }).from(docNodes).where(eq(docNodes.docId, docId));
  }

  nodeAnchors(nodeIds: string[]) {
    return this.db.q.select({ anchors: nodes.anchors }).from(nodes).where(inArray(nodes.id, nodeIds));
  }

  async linkNode(docId: string, nodeId: string) {
    await this.db.q.insert(docNodes).values({ docId, nodeId }).onConflictDoNothing();
  }

  async unlinkNode(docId: string, nodeId: string) {
    await this.db.q.delete(docNodes).where(and(eq(docNodes.docId, docId), eq(docNodes.nodeId, nodeId)));
  }

  // ───────── docs ─────────

  /** A live doc of the team by uuid. */
  async findDocById(teamId: string, id: string): Promise<DocRow | undefined> {
    const [d] = await this.db.q.select().from(docs).where(and(eq(docs.id, id), eq(docs.teamId, teamId), isNull(docs.deletedAt)));
    return d;
  }

  /** A live doc of the team by slug under one parent (`null`: the top level). */
  async findDocBySlug(teamId: string, parentId: string | null, slug: string): Promise<DocRow | undefined> {
    const [d] = await this.db.q
      .select()
      .from(docs)
      .where(and(eq(docs.teamId, teamId), eq(docs.slug, slug), isNull(docs.deletedAt), parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId)));
    return d;
  }

  /** The parent of a doc, by id; scoped to a team when one is given. */
  async parentOf(id: string, teamId?: string): Promise<{ parentId: string | null } | undefined> {
    const [p] = await this.db.q
      .select({ parentId: docs.parentId })
      .from(docs)
      .where(teamId ? and(eq(docs.id, id), eq(docs.teamId, teamId)) : eq(docs.id, id));
    return p;
  }

  /** Whether another live doc of the team already has this slug under the same parent. */
  async slugTaken(teamId: string, parentId: string | null, slug: string, excludeId?: string): Promise<boolean> {
    const [clash] = await this.db.q
      .select({ id: docs.id })
      .from(docs)
      .where(
        and(
          eq(docs.teamId, teamId),
          eq(docs.slug, slug),
          isNull(docs.deletedAt),
          parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId),
          excludeId ? ne(docs.id, excludeId) : undefined,
        ),
      );
    return !!clash;
  }

  /** Every live doc of the team, in tree order, with what the tree shows (no bodies). */
  listLiveDocs(teamId: string) {
    return this.db.q
      .select({
        id: docs.id,
        parentId: docs.parentId,
        slug: docs.slug,
        title: docs.title,
        version: docs.version,
        position: docs.position,
        updatedAt: docs.updatedAt,
        stale: docs.stale,
      })
      .from(docs)
      .where(and(eq(docs.teamId, teamId), isNull(docs.deletedAt), eq(docs.kind, "markdown")))
      .orderBy(asc(docs.position));
  }

  /** Every live drawing of the team, newest edit first, with its thumbnail (no scene bodies). */
  listLiveDrawings(teamId: string) {
    return this.db.q
      .select({ id: docs.id, slug: docs.slug, title: docs.title, version: docs.version, updatedAt: docs.updatedAt, thumbnail: docs.thumbnail, updatedByKind: docs.updatedByKind, updatedById: docs.updatedById })
      .from(docs)
      .where(and(eq(docs.teamId, teamId), isNull(docs.deletedAt), eq(docs.kind, "drawing")))
      .orderBy(desc(docs.updatedAt));
  }

  /** Titles and slugs only, for the briefing. */
  liveDocTitles(teamId: string) {
    return this.db.q
      .select({ slug: docs.slug, title: docs.title, parentId: docs.parentId })
      .from(docs)
      .where(and(eq(docs.teamId, teamId), isNull(docs.deletedAt), eq(docs.kind, "markdown")))
      .orderBy(asc(docs.position));
  }

  /** The events that created or changed a doc, oldest first: who wrote it. */
  docWriters(workspaceId: string, docId: string) {
    return this.db.q
      .select({ type: events.type, actorKind: events.actorKind, actorId: events.actorId, actorName: events.actorName })
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.entity, "doc"), eq(events.entityId, docId), inArray(events.type, ["doc.created", "doc.updated"])))
      .orderBy(asc(events.seq));
  }

  /** How many live docs the team has (the per-team limit). */
  async liveDocCount(teamId: string): Promise<number> {
    const [{ n }] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(docs).where(and(eq(docs.teamId, teamId), isNull(docs.deletedAt)));
    return n;
  }

  /** The live siblings of a doc (`parentId` null: the top level), with their positions. */
  siblingPositions(teamId: string, parentId: string | null, exceptId?: string) {
    return this.db.q
      .select({ id: docs.id, position: docs.position })
      .from(docs)
      .where(
        and(
          eq(docs.teamId, teamId),
          isNull(docs.deletedAt),
          parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId),
          exceptId ? ne(docs.id, exceptId) : undefined,
        ),
      )
      .orderBy(asc(docs.position));
  }

  /** The live children of a doc. */
  async liveChildIds(parentId: string): Promise<string[]> {
    const kids = await this.db.q.select({ id: docs.id }).from(docs).where(and(eq(docs.parentId, parentId), isNull(docs.deletedAt)));
    return kids.map((k) => k.id);
  }

  async insertDoc(values: typeof docs.$inferInsert): Promise<DocRow> {
    const [d] = await this.db.q.insert(docs).values(values).returning();
    return d;
  }

  /** The doc as it is now, read under a row lock for the rest of the transaction; undefined when it is gone. */
  async lockDoc(id: string): Promise<DocRow | undefined> {
    const [fresh] = await this.db.q.select().from(docs).where(eq(docs.id, id)).for("update");
    return fresh;
  }

  async updateDoc(id: string, set: Partial<typeof docs.$inferInsert>): Promise<DocRow> {
    const [row] = await this.db.q.update(docs).set(set).where(eq(docs.id, id)).returning();
    return row;
  }

  async softDeleteDocs(ids: string[]) {
    await this.db.q.update(docs).set({ deletedAt: new Date() }).where(inArray(docs.id, ids));
  }

  /** The live docs whose text matches the query, best first, with the ranking and a snippet (the budget is the service's). */
  searchDocs(teamId: string, q: string) {
    const tsq = sql`websearch_to_tsquery('english', ${q})`;
    const vector = sql`setweight(to_tsvector('english', ${docs.title}), 'A') || setweight(to_tsvector('english', ${docs.body}), 'B')`;
    return this.db.q
      .select({
        id: docs.id,
        slug: docs.slug,
        title: docs.title,
        body: docs.body,
        updatedAt: docs.updatedAt,
        rank: sql<number>`ts_rank(${vector}, ${tsq})`,
        snippet: sql<string>`ts_headline('english', ${docs.body}, ${tsq}, 'MaxFragments=2, MinWords=5, MaxWords=25')`,
      })
      .from(docs)
      .where(and(eq(docs.teamId, teamId), isNull(docs.deletedAt), eq(docs.kind, "markdown"), sql`${vector} @@ ${tsq}`))
      .orderBy(desc(sql`ts_rank(${vector}, ${tsq})`))
      .limit(50);
  }

  // ───────── freshness ─────────

  /** Every live doc of the team, whole rows (the freshness rules match their anchors). */
  liveDocRows(teamId: string) {
    return this.db.q.select().from(docs).where(and(eq(docs.teamId, teamId), isNull(docs.deletedAt)));
  }

  /** Docs flagged stale, with the reason and the anchors to re-read. */
  staleDocsOf(teamId: string) {
    return this.db.q
      .select({ id: docs.id, slug: docs.slug, title: docs.title, reason: docs.staleReason, anchors: docs.anchors })
      .from(docs)
      .where(and(eq(docs.teamId, teamId), eq(docs.stale, true), isNull(docs.deletedAt)));
  }

  async updateDocFreshness(id: string, set: Partial<typeof docs.$inferInsert>) {
    await this.db.q.update(docs).set(set).where(eq(docs.id, id));
  }

  // ───────── doc drafts (the flow mirrors the map's node drafts) ─────────

  pendingDocDraftsOfSession(sessionId: string) {
    return this.db.q.select().from(docDrafts).where(and(eq(docDrafts.sessionId, sessionId), eq(docDrafts.status, "pending")));
  }

  pendingDocDraftsOf(teamId: string) {
    return this.db.q.select().from(docDrafts).where(and(eq(docDrafts.teamId, teamId), eq(docDrafts.status, "pending"))).orderBy(asc(docDrafts.createdAt));
  }

  pendingDocDraftsFor(docIds: string[]) {
    return this.db.q.select().from(docDrafts).where(and(inArray(docDrafts.docId, docIds), eq(docDrafts.status, "pending"))).orderBy(asc(docDrafts.createdAt));
  }

  async pendingDocDraft(docId: string, sessionId: string): Promise<DocDraftRow | undefined> {
    const [d] = await this.db.q
      .select()
      .from(docDrafts)
      .where(and(eq(docDrafts.docId, docId), eq(docDrafts.sessionId, sessionId), eq(docDrafts.status, "pending")));
    return d;
  }

  async findPendingDocDraft(teamId: string, id: string): Promise<DocDraftRow | undefined> {
    const [d] = await this.db.q.select().from(docDrafts).where(and(eq(docDrafts.id, id), eq(docDrafts.teamId, teamId), eq(docDrafts.status, "pending")));
    return d;
  }

  async insertDocDraft(values: typeof docDrafts.$inferInsert) {
    await this.db.q.insert(docDrafts).values(values);
  }

  async updateDocDraft(id: string, set: Partial<typeof docDrafts.$inferInsert>) {
    await this.db.q.update(docDrafts).set(set).where(eq(docDrafts.id, id));
  }
}
