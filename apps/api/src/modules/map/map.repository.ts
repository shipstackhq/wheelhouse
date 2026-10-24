import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { nodes, edges, flows, decisions, decisionNodes, terms, nodeDrafts, workSessions, teamFiles, issueNodes, issues, events, docs, docDrafts, repositories } = schema;

export type NodeRow = typeof nodes.$inferSelect;
export type NodeInsert = typeof nodes.$inferInsert;
export type EdgeRow = typeof edges.$inferSelect;
export type FlowRow = typeof flows.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type TermRow = typeof terms.$inferSelect;
export type SessionRow = typeof workSessions.$inferSelect;
export type NodeDraftRow = typeof nodeDrafts.$inferSelect;
export type DocDraftRow = typeof docDrafts.$inferSelect;
export type DocRow = typeof docs.$inferSelect;
type TeamRef = { id: string; workspaceId: string };

/**
 * Every query on the map's tables (nodes, edges, flows, decisions, decision_nodes, terms, node_drafts, work_sessions) and on the rows
 * the map reads or writes next to them: the files that landed (team_files), the docs and doc drafts that follow the same freshness
 * rules, and, as read-only lookups, issues, issue_nodes and the event log. The only file in the module that touches Drizzle. Each
 * method reads `this.db.q`, so it runs on the current transaction when a service opened one. It decides nothing: the rules are in the services.
 */
@Injectable()
export class MapRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── nodes ─────────

  nodesOf(teamId: string) {
    return this.db.q.select().from(nodes).where(eq(nodes.teamId, teamId));
  }

  dataNodesOf(teamId: string) {
    return this.db.q.select().from(nodes).where(and(eq(nodes.teamId, teamId), eq(nodes.layer, "data")));
  }

  /** The nodes of a team with this id, or with this name (case-insensitive), optionally on one layer. */
  findNodes(teamId: string, by: { id: string } | { name: string; layer?: NodeRow["layer"] }) {
    return this.db.q
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.teamId, teamId),
          "id" in by ? eq(nodes.id, by.id) : eq(sql`lower(${nodes.name})`, by.name.toLowerCase()),
          "layer" in by && by.layer ? eq(nodes.layer, by.layer) : undefined,
        ),
      );
  }

  /** The node as it is now, read under a row lock for the rest of the transaction; undefined when it is gone. */
  async lockNode(id: string): Promise<NodeRow | undefined> {
    const [fresh] = await this.db.q.select().from(nodes).where(eq(nodes.id, id)).for("update");
    return fresh;
  }

  async insertNode(values: NodeInsert): Promise<NodeRow> {
    const [n] = await this.db.q.insert(nodes).values(values).returning();
    return n;
  }

  async updateNode(id: string, set: Partial<NodeInsert>): Promise<NodeRow> {
    const [n] = await this.db.q.update(nodes).set(set).where(eq(nodes.id, id)).returning();
    return n;
  }

  /** How many nodes sit beside a new one: same layer, same parent (`null`: the top level). */
  async siblingCount(teamId: string, layer: NodeRow["layer"], parentId: string | null): Promise<number> {
    const rows = await this.db.q
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.teamId, teamId), eq(nodes.layer, layer), parentId ? eq(nodes.parentId, parentId) : sql`${nodes.parentId} is null`));
    return rows.length;
  }

  /** Where the data layer's cards are, and how many columns each has, to stack a new one. */
  dataPlacement(teamId: string) {
    return this.db.q.select({ x: nodes.x, y: nodes.y, columns: nodes.columns }).from(nodes).where(and(eq(nodes.teamId, teamId), eq(nodes.layer, "data")));
  }

  async setPosition(teamId: string, id: string, set: Partial<NodeInsert>) {
    await this.db.q.update(nodes).set(set).where(and(eq(nodes.id, id), eq(nodes.teamId, teamId)));
  }

  /** Every node's id and parent, to find a subtree (children point at their parent without a foreign key). */
  nodeParents(teamId: string) {
    return this.db.q.select({ id: nodes.id, parentId: nodes.parentId }).from(nodes).where(eq(nodes.teamId, teamId));
  }

  async deleteNodes(ids: string[]) {
    await this.db.q.delete(nodes).where(inArray(nodes.id, ids));
  }

  nodeNames(ids: string[]) {
    return this.db.q.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, ids));
  }

  staleNodes(teamId: string) {
    return this.db
      .q.select({ id: nodes.id, name: nodes.name, layer: nodes.layer, kind: nodes.kind, reason: nodes.staleReason, anchors: nodes.anchors })
      .from(nodes)
      .where(and(eq(nodes.teamId, teamId), eq(nodes.stale, true)));
  }

  // ───────── edges ─────────

  edgesOf(teamId: string) {
    return this.db.q.select().from(edges).where(eq(edges.teamId, teamId));
  }

  referenceEdgesOf(teamId: string) {
    return this.db.q.select().from(edges).where(and(eq(edges.teamId, teamId), eq(edges.kind, "references")));
  }

  async findEdge(fromNodeId: string, toNodeId: string, kind: EdgeRow["kind"]) {
    const [e] = await this.db.q.select().from(edges).where(and(eq(edges.fromNodeId, fromNodeId), eq(edges.toNodeId, toNodeId), eq(edges.kind, kind)));
    return e;
  }

  /** The edges from one node to another, of one kind or of any. */
  edgesBetween(fromNodeId: string, toNodeId: string, kind?: EdgeRow["kind"]) {
    return this.db.q
      .select({ id: edges.id })
      .from(edges)
      .where(and(eq(edges.fromNodeId, fromNodeId), eq(edges.toNodeId, toNodeId), kind ? eq(edges.kind, kind) : undefined));
  }

  async insertEdge(values: typeof edges.$inferInsert): Promise<EdgeRow> {
    const [e] = await this.db.q.insert(edges).values(values).returning();
    return e;
  }

  async updateEdge(id: string, set: Partial<typeof edges.$inferInsert>): Promise<EdgeRow> {
    const [e] = await this.db.q.update(edges).set(set).where(eq(edges.id, id)).returning();
    return e;
  }

  async deleteEdgeById(id: string) {
    await this.db.q.delete(edges).where(eq(edges.id, id));
  }

  /** Deletes the team's edge and returns it; undefined when there was none. */
  async deleteEdgeOf(teamId: string, id: string): Promise<EdgeRow | undefined> {
    const [e] = await this.db.q.delete(edges).where(and(eq(edges.id, id), eq(edges.teamId, teamId))).returning();
    return e;
  }

  // ───────── what hangs off the nodes: issue links ─────────

  /** The issues attached to these nodes (the table `issue_nodes` is the issues module's; the map only reads it). */
  issueLinks(nodeIds: string[]) {
    return this.db.q
      .select({ nodeId: issueNodes.nodeId, issueId: issues.id, number: issues.number, title: issues.title, statusId: issues.statusId })
      .from(issueNodes)
      .innerJoin(issues, eq(issues.id, issueNodes.issueId))
      .where(inArray(issueNodes.nodeId, nodeIds));
  }

  // ───────── flows ─────────

  flowsOf(teamId: string) {
    return this.db.q.select().from(flows).where(eq(flows.teamId, teamId)).orderBy(asc(flows.name));
  }

  /** A flow of the team by id or by name (case-insensitive); `lock` reads it under a row lock, so a second edit from the same version waits and is then refused. */
  async findFlow(teamId: string, by: { id: string } | { name: string }, lock = false): Promise<FlowRow | undefined> {
    const q = this.db.q
      .select()
      .from(flows)
      .where(and(eq(flows.teamId, teamId), "id" in by ? eq(flows.id, by.id) : eq(sql`lower(${flows.name})`, by.name.toLowerCase())));
    const [f] = await (lock ? q.for("update") : q);
    return f;
  }

  async insertFlow(values: typeof flows.$inferInsert): Promise<FlowRow> {
    const [f] = await this.db.q.insert(flows).values(values).returning();
    return f;
  }

  async updateFlow(id: string, set: Partial<typeof flows.$inferInsert>): Promise<FlowRow> {
    const [f] = await this.db.q.update(flows).set(set).where(eq(flows.id, id)).returning();
    return f;
  }

  async deleteFlow(id: string) {
    await this.db.q.delete(flows).where(eq(flows.id, id));
  }

  // ───────── decisions ─────────

  decisionsOf(teamId: string) {
    return this.db.q.select().from(decisions).where(eq(decisions.teamId, teamId)).orderBy(asc(decisions.number));
  }

  /** The ADR as it is now, read under a row lock. */
  async lockDecision(teamId: string, number: number): Promise<DecisionRow | undefined> {
    const [d] = await this.db.q.select().from(decisions).where(and(eq(decisions.teamId, teamId), eq(decisions.number, number))).for("update");
    return d;
  }

  async maxDecisionNumber(teamId: string): Promise<number> {
    const [{ max }] = await this.db.q.select({ max: sql<number>`coalesce(max(${decisions.number}), 0)::int` }).from(decisions).where(eq(decisions.teamId, teamId));
    return Number(max);
  }

  async insertDecision(values: typeof decisions.$inferInsert): Promise<DecisionRow> {
    const [d] = await this.db.q.insert(decisions).values(values).returning();
    return d;
  }

  async updateDecision(id: string, set: Partial<typeof decisions.$inferInsert>): Promise<DecisionRow> {
    const [d] = await this.db.q.update(decisions).set(set).where(eq(decisions.id, id)).returning();
    return d;
  }

  /** The nodes each ADR applies to (the nodes ADRs apply to are rows, WH-115: the database checks them and a delete removes them). */
  async decisionNodeIds(decisionIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>(decisionIds.map((id) => [id, []]));
    if (!decisionIds.length) return out;
    const rows = await this.db.q
      .select({ decisionId: decisionNodes.decisionId, nodeId: decisionNodes.nodeId, name: nodes.name })
      .from(decisionNodes)
      .innerJoin(nodes, eq(nodes.id, decisionNodes.nodeId))
      .where(inArray(decisionNodes.decisionId, decisionIds))
      .orderBy(asc(nodes.name), asc(nodes.id));
    for (const r of rows) out.get(r.decisionId)!.push(r.nodeId);
    return out;
  }

  /** Rows of decisions with their `nodeIds` on them. */
  async withNodeIds<T extends { id: string }>(rows: T[]): Promise<(T & { nodeIds: string[] })[]> {
    const ids = await this.decisionNodeIds(rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, nodeIds: ids.get(r.id) ?? [] }));
  }

  /** Makes an ADR apply to exactly these nodes (already resolved, and of the team: the foreign keys refuse anything else). */
  async setDecisionNodes(team: TeamRef, decisionId: string, nodeIds: string[]) {
    const ids = [...new Set(nodeIds)];
    await this.db.q.delete(decisionNodes).where(and(eq(decisionNodes.decisionId, decisionId), ids.length ? notInArray(decisionNodes.nodeId, ids) : undefined));
    if (ids.length) {
      await this.db.q
        .insert(decisionNodes)
        .values(ids.map((nodeId) => ({ decisionId, nodeId, teamId: team.id, workspaceId: team.workspaceId })))
        .onConflictDoNothing();
    }
  }

  // ───────── glossary ─────────

  termsOf(teamId: string) {
    return this.db.q.select().from(terms).where(eq(terms.teamId, teamId)).orderBy(asc(terms.term));
  }

  /** A term of the team by id or by the word (case-insensitive). */
  async findTerm(teamId: string, by: { id: string } | { term: string }): Promise<TermRow | undefined> {
    const [t] = await this.db.q
      .select()
      .from(terms)
      .where(and(eq(terms.teamId, teamId), "id" in by ? eq(terms.id, by.id) : eq(sql`lower(${terms.term})`, by.term.toLowerCase())));
    return t;
  }

  async insertTerm(values: typeof terms.$inferInsert): Promise<TermRow> {
    const [t] = await this.db.q.insert(terms).values(values).returning();
    return t;
  }

  async updateTerm(id: string, set: Partial<typeof terms.$inferInsert>): Promise<TermRow> {
    const [t] = await this.db.q.update(terms).set(set).where(eq(terms.id, id)).returning();
    return t;
  }

  async deleteTerm(id: string) {
    await this.db.q.delete(terms).where(eq(terms.id, id));
  }

  // ───────── the files that landed ─────────

  /** Path and content hash of every file that has landed for the team. */
  landedFiles(teamId: string) {
    return this.db.q.select({ path: teamFiles.path, hash: teamFiles.hash }).from(teamFiles).where(eq(teamFiles.teamId, teamId));
  }

  landedFilesAt(teamId: string, paths: string[]) {
    return this.db.q.select().from(teamFiles).where(and(eq(teamFiles.teamId, teamId), inArray(teamFiles.path, paths)));
  }

  async upsertLandedFile(values: typeof teamFiles.$inferInsert) {
    await this.db.q
      .insert(teamFiles)
      .values(values)
      .onConflictDoUpdate({
        target: [teamFiles.teamId, teamFiles.path],
        set: { hash: values.hash, sha: values.sha, repositoryId: values.repositoryId, updatedAt: new Date() },
      });
  }

  async deleteLandedFile(teamId: string, path: string) {
    await this.db.q.delete(teamFiles).where(and(eq(teamFiles.teamId, teamId), eq(teamFiles.path, path)));
  }

  // ───────── docs (they follow the map's freshness rules; the docs module owns the tables) ─────────

  liveDocsOf(teamId: string) {
    return this.db.q.select().from(docs).where(and(eq(docs.teamId, teamId), isNull(docs.deletedAt)));
  }

  staleDocsOf(teamId: string) {
    return this.db.q
      .select({ id: docs.id, slug: docs.slug, title: docs.title, reason: docs.staleReason, anchors: docs.anchors })
      .from(docs)
      .where(and(eq(docs.teamId, teamId), eq(docs.stale, true), isNull(docs.deletedAt)));
  }

  async updateDocFreshness(id: string, set: Partial<typeof docs.$inferInsert>) {
    await this.db.q.update(docs).set(set).where(eq(docs.id, id));
  }

  /** A repository saw activity now (the github module owns the table). */
  async touchRepository(id: string) {
    await this.db.q.update(repositories).set({ lastEventAt: new Date() }).where(eq(repositories.id, id));
  }

  // ───────── work sessions ─────────

  /** Sessions of the team still open and seen in the last `activeMs`, newest first; of one key when `apiKeyId` is given. */
  activeSessions(teamId: string, activeMs: number, apiKeyId?: string) {
    return this.db.q
      .select()
      .from(workSessions)
      .where(
        and(
          eq(workSessions.teamId, teamId),
          isNull(workSessions.endedAt),
          gte(workSessions.lastSeenAt, new Date(Date.now() - activeMs)),
          apiKeyId ? eq(workSessions.apiKeyId, apiKeyId) : undefined,
        ),
      )
      .orderBy(desc(workSessions.lastSeenAt));
  }

  async findSession(id: string, teamId?: string): Promise<SessionRow | undefined> {
    const [s] = await this.db.q.select().from(workSessions).where(and(eq(workSessions.id, id), teamId ? eq(workSessions.teamId, teamId) : undefined));
    return s;
  }

  async insertSession(values: typeof workSessions.$inferInsert) {
    await this.db.q.insert(workSessions).values(values);
  }

  async updateSession(id: string, set: Partial<typeof workSessions.$inferInsert>) {
    await this.db.q.update(workSessions).set(set).where(eq(workSessions.id, id));
  }

  async endSession(teamId: string, id: string) {
    await this.db.q.update(workSessions).set({ endedAt: new Date() }).where(and(eq(workSessions.id, id), eq(workSessions.teamId, teamId)));
  }

  // ───────── node drafts ─────────

  pendingNodeDraftsOfSession(sessionId: string) {
    return this.db.q.select().from(nodeDrafts).where(and(eq(nodeDrafts.sessionId, sessionId), eq(nodeDrafts.status, "pending")));
  }

  pendingNodeDraftsOf(teamId: string) {
    return this.db.q.select().from(nodeDrafts).where(and(eq(nodeDrafts.teamId, teamId), eq(nodeDrafts.status, "pending"))).orderBy(asc(nodeDrafts.createdAt));
  }

  pendingNodeDraftsFor(nodeIds: string[]) {
    return this.db.q.select().from(nodeDrafts).where(and(inArray(nodeDrafts.nodeId, nodeIds), eq(nodeDrafts.status, "pending"))).orderBy(asc(nodeDrafts.createdAt));
  }

  async pendingNodeDraft(nodeId: string, sessionId: string): Promise<NodeDraftRow | undefined> {
    const [d] = await this.db.q
      .select()
      .from(nodeDrafts)
      .where(and(eq(nodeDrafts.nodeId, nodeId), eq(nodeDrafts.sessionId, sessionId), eq(nodeDrafts.status, "pending")));
    return d;
  }

  async findPendingNodeDraft(teamId: string, id: string): Promise<NodeDraftRow | undefined> {
    const [d] = await this.db.q.select().from(nodeDrafts).where(and(eq(nodeDrafts.id, id), eq(nodeDrafts.teamId, teamId), eq(nodeDrafts.status, "pending")));
    return d;
  }

  async insertNodeDraft(values: typeof nodeDrafts.$inferInsert) {
    await this.db.q.insert(nodeDrafts).values(values);
  }

  async updateNodeDraft(id: string, set: Partial<typeof nodeDrafts.$inferInsert>) {
    await this.db.q.update(nodeDrafts).set(set).where(eq(nodeDrafts.id, id));
  }

  /** The nodes (of those given) that this session has a pending draft for. */
  async draftedNodeIds(nodeIds: string[], sessionId: string): Promise<string[]> {
    if (!nodeIds.length) return [];
    const rows = await this.db.q
      .select({ nodeId: nodeDrafts.nodeId })
      .from(nodeDrafts)
      .where(and(inArray(nodeDrafts.nodeId, nodeIds), eq(nodeDrafts.sessionId, sessionId), eq(nodeDrafts.status, "pending")));
    return rows.map((d) => d.nodeId);
  }

  // ───────── doc drafts (the docs module owns the table; the flow mirrors node drafts) ─────────

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

  // ───────── issues and the event log (read-only lookups for a session's debt) ─────────

  async issueById(id: string) {
    const [i] = await this.db.q.select().from(issues).where(eq(issues.id, id));
    return i;
  }

  issueNumbers(teamId: string) {
    return this.db.q.select({ id: issues.id, number: issues.number }).from(issues).where(eq(issues.teamId, teamId));
  }

  /** The latest issue event by this key in the team since a time. */
  async latestIssueEventBy(teamId: string, keyId: string, since: Date) {
    const [e] = await this.db.q
      .select()
      .from(events)
      .where(and(eq(events.teamId, teamId), eq(events.actorId, keyId), eq(events.entity, "issue"), gte(events.createdAt, since)))
      .orderBy(desc(events.seq))
      .limit(1);
    return e;
  }

  /** Whether this key commented on, moved or updated the issue after a time. */
  async issueUpdatedBy(issueId: string, keyId: string, since: Date): Promise<boolean> {
    const [upd] = await this.db.q
      .select({ seq: events.seq })
      .from(events)
      .where(and(eq(events.entityId, issueId), eq(events.actorId, keyId), inArray(events.type, ["comment.created", "issue.moved", "issue.updated"]), gt(events.createdAt, since)))
      .limit(1);
    return !!upd;
  }

  /** Which of these entities this key wrote an event for after a time. */
  async entityIdsEditedBy(entityIds: string[], keyId: string, since: Date): Promise<string[]> {
    if (!entityIds.length) return [];
    const rows = await this.db.q
      .select({ id: events.entityId })
      .from(events)
      .where(and(inArray(events.entityId, entityIds), eq(events.actorId, keyId), gt(events.createdAt, since)));
    return rows.map((e) => e.id);
  }
}
