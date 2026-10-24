import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { oneOf, text, textList, textOrNull, whole } from "../../lib/web-input";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";
import { diff } from "../../platform/events/emit";
import { EventsService } from "../../platform/events/events.service";
import { TeamAccessService } from "../teams/index";
import { GraphService } from "./graph.service";
import { MapRepository } from "./map.repository";

type Body = Record<string, unknown>;

export type DecisionInput = {
  number?: number;
  title?: string;
  status?: (typeof schema.DECISION_STATUSES)[number];
  context?: string;
  decision?: string;
  consequences?: string;
  nodes?: string[];
  /** Optimistic lock, as on nodes: the decision version the caller last read (updates only). */
  expectedVersion?: number;
};

/** Decisions (ADRs, numbered per team, each applying to some nodes) and the glossary. Every method resolves the team through TeamAccessService. */
@Injectable()
export class DecisionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MapRepository) private readonly repo: MapRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(GraphService) private readonly graph: GraphService,
  ) {}

  // ───────── decisions ─────────

  async listDecisions(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    return this.repo.withNodeIds(await this.repo.decisionsOf(team.id));
  }

  /** Create (no number) or update (number) an ADR. */
  async upsertDecision(actor: Actor, teamRef: string, input: DecisionInput) {
    const team = await this.access.require(actor, teamRef, "edit");
    return this.db.transaction(async () => {
      const nodeIds = input.nodes ? await Promise.all(input.nodes.map(async (r) => (await this.graph.resolveNode(team.id, r)).id)) : undefined;
      if (input.number !== undefined) {
        const d = await this.repo.lockDecision(team.id, input.number);
        if (!d) throw new ServiceError("not_found", `Decision ADR-${input.number} not found`);
        if (input.expectedVersion !== undefined && input.expectedVersion !== d.version) {
          throw new ServiceError("conflict", `ADR-${d.number} was changed (version ${d.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: (await this.repo.withNodeIds([d]))[0] });
        }
        const [current] = await this.repo.withNodeIds([d]);
        const patch = {
          title: input.title,
          status: input.status,
          context: input.context,
          decision: input.decision,
          consequences: input.consequences,
          nodeIds,
        };
        const changes = diff(current as unknown as Record<string, unknown>, patch as Record<string, unknown>);
        if (!Object.keys(changes).length) return current;
        const { nodeIds: newNodes, ...columnsPatch } = patch;
        const row = await this.repo.updateDecision(d.id, { ...Object.fromEntries(Object.entries(columnsPatch).filter(([, v]) => v !== undefined)), version: d.version + 1, updatedAt: new Date() });
        if (newNodes) await this.repo.setDecisionNodes(team, row.id, newNodes);
        const u = { ...row, nodeIds: newNodes ?? current.nodeIds };
        await this.events.emit(actor, team.id, {
          type: "decision.updated",
          entity: "decision",
          entityId: u.id,
          summary: `updated ADR-${u.number} "${u.title}": ${Object.keys(changes).join(", ")}`,
          data: { number: u.number },
        });
        return u;
      }
      if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
      const max = await this.repo.maxDecisionNumber(team.id);
      const d = await this.repo.insertDecision({
        teamId: team.id,
        workspaceId: team.workspaceId,
        number: max + 1,
        title: input.title.trim(),
        status: input.status ?? "accepted",
        context: input.context ?? "",
        decision: input.decision ?? "",
        consequences: input.consequences ?? "",
        authorKind: actor.kind,
        authorName: actor.name,
      });
      await this.repo.setDecisionNodes(team, d.id, nodeIds ?? []);
      await this.events.emit(actor, team.id, {
        type: "decision.created",
        entity: "decision",
        entityId: d.id,
        summary: `recorded ADR-${d.number} "${d.title}"`,
        data: { number: d.number },
      });
      return { ...d, nodeIds: [...new Set(nodeIds ?? [])] };
    });
  }

  // ───────── glossary ─────────

  async listTerms(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    return this.repo.termsOf(team.id);
  }

  async upsertTerm(actor: Actor, teamRef: string, input: { term: string; definition: string; node?: string | null }) {
    const team = await this.access.require(actor, teamRef, "edit");
    const term = input.term?.trim();
    if (!term || !input.definition?.trim()) throw new ServiceError("invalid", "term and definition are required");
    return this.db.transaction(async () => {
      const nodeId = input.node === null ? null : input.node ? (await this.graph.resolveNode(team.id, input.node)).id : undefined;
      const existing = await this.repo.findTerm(team.id, { term });
      if (existing) {
        if (existing.definition === input.definition.trim() && (nodeId === undefined || nodeId === existing.nodeId) && existing.term === term) return existing;
        const t = await this.repo.updateTerm(existing.id, { term, definition: input.definition.trim(), ...(nodeId !== undefined ? { nodeId } : {}), updatedAt: new Date() });
        await this.events.emit(actor, team.id, { type: "term.updated", entity: "term", entityId: t.id, summary: `updated glossary term "${t.term}"` });
        return t;
      }
      const t = await this.repo.insertTerm({ teamId: team.id, workspaceId: team.workspaceId, term, definition: input.definition.trim(), nodeId: nodeId ?? null });
      await this.events.emit(actor, team.id, { type: "term.created", entity: "term", entityId: t.id, summary: `defined glossary term "${t.term}"` });
      return t;
    });
  }

  async deleteTerm(actor: Actor, teamRef: string, term: string) {
    const team = await this.access.require(actor, teamRef, "edit");
    const t = await this.repo.findTerm(team.id, isUuid(term) ? { id: term } : { term });
    if (!t) throw new ServiceError("not_found", `Term "${term}" not found`);
    await this.repo.deleteTerm(t.id);
    await this.events.emit(actor, team.id, { type: "term.deleted", entity: "term", entityId: t.id, summary: `removed glossary term "${t.term}"` });
    return { ok: true };
  }

  // ───────── the web app's bodies ─────────

  upsertDecisionAs(actor: Actor, teamKey: string, b: Body) {
    const input: DecisionInput = {
      number: whole(b, "number"),
      title: text(b, "title", { max: 300 }),
      status: oneOf(b, "status", schema.DECISION_STATUSES),
      context: text(b, "context", { max: 50_000 }),
      decision: text(b, "decision", { max: 50_000 }),
      consequences: text(b, "consequences", { max: 50_000 }),
      nodes: textList(b, "nodes"),
      expectedVersion: whole(b, "version"),
    };
    return this.upsertDecision(actor, teamKey, input);
  }

  upsertTermAs(actor: Actor, teamKey: string, term: string, b: Body) {
    const definition = text(b, "definition", { required: true, max: 5000 })!;
    const node = textOrNull(b, "node");
    return this.upsertTerm(actor, teamKey, { term, definition, node });
  }
}
