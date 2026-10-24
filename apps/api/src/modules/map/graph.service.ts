import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { bad, oneOf, text, whole } from "../../lib/web-input";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";
import { diff } from "../../platform/events/emit";
import { EventsService } from "../../platform/events/events.service";
import { TeamAccessService } from "../teams/index";
import { EXPLAINER_FIELDS, LAYER_RANK, anchorScore, checkKind, cleanColumn, defaultKind, layoutInput, nodeInput, tableHeight, type Layer, type NodeInput } from "./map.rules";
import { MapRepository, type NodeRow } from "./map.repository";
import { SessionsService } from "./sessions.service";

type Body = Record<string, unknown>;

export type FlowInput = {
  id?: string;
  name: string;
  description?: string;
  steps?: { node: string; title: string; detail?: string }[];
  /** Optimistic lock, as on nodes: the flow version the caller last read. */
  expectedVersion?: number;
};

export type Graph = Awaited<ReturnType<GraphService["getGraph"]>>;

/**
 * The knowledge map: one linked model at three zoom levels (concept, system, code) plus the data layer. `depends` edges connect nodes
 * within a level; `implements` edges connect a lower level to the higher-level thing it realizes. Flows hang off nodes, and anchors with
 * reported file changes keep the explanations honest (the freshness service). Every method resolves the team through
 * TeamAccessService, so another workspace's team or node is "not found". The `...As` methods take the request body as the web app sends it
 * and check it; the controller maps the answers with the presenter.
 */
@Injectable()
export class GraphService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MapRepository) private readonly repo: MapRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  async getGraph(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    const ns = await this.repo.nodesOf(team.id);
    const es = await this.repo.edgesOf(team.id);
    const nodeIds = ns.map((n) => n.id);
    const links = nodeIds.length ? await this.repo.issueLinks(nodeIds) : [];
    const fl = await this.repo.flowsOf(team.id);
    const ds = await this.repo.decisionsOf(team.id);
    const ts = await this.repo.termsOf(team.id);
    const alive = new Set(nodeIds);
    return {
      team,
      nodes: ns,
      edges: es,
      issueLinks: links.map((l) => ({ ...l, ref: `${team.key}-${l.number}` })),
      flows: fl.map((f) => ({ ...f, steps: f.steps.filter((s) => alive.has(s.nodeId)) })),
      decisions: (await this.repo.withNodeIds(ds)).map((d) => ({ ...d, nodeIds: d.nodeIds.filter((id) => alive.has(id)) })),
      terms: ts,
      // Nodes whose files are being changed in active sessions, and pending drafts.
      flux: await this.sessions.fluxForTeam(team.id, team.key),
    };
  }

  /**
   * Resolve a node by uuid or name (case-insensitive). Names may repeat across layers ("Billing" concept vs "billing" service), so pass
   * `layer` or use the "layer:name" form to disambiguate.
   */
  async resolveNode(teamId: string, ref: string, layer?: Layer) {
    let name = ref.trim();
    const m = /^(concept|system|data|code):(.+)$/i.exec(name);
    if (m) {
      layer = m[1].toLowerCase() as Layer;
      name = m[2].trim();
    }
    const rows = await this.repo.findNodes(teamId, isUuid(name) ? { id: name } : { name, layer });
    if (!rows.length) throw new ServiceError("not_found", `Node "${ref}" not found`);
    if (rows.length > 1)
      throw new ServiceError(
        "invalid",
        `"${ref}" is ambiguous (${rows.map((r) => `${r.layer}:${r.name}`).join(", ")}). Prefix with the layer, e.g. "${rows[0].layer}:${rows[0].name}".`,
      );
    return rows[0];
  }

  /** Everything about one node: explainer, neighbours on every layer, flows, decisions, issues. */
  async getNode(actor: Actor, teamRef: string, ref: string) {
    const g = await this.getGraph(actor, teamRef);
    const n = await this.resolveNode(g.team.id, ref);
    const byId = new Map(g.nodes.map((x) => [x.id, x]));
    const brief = (x: NodeRow | undefined) => x && { id: x.id, name: x.name, layer: x.layer, kind: x.kind, summary: x.summary, stale: x.stale };
    const out = g.edges.filter((e) => e.fromNodeId === n.id);
    const inc = g.edges.filter((e) => e.toNodeId === n.id);
    return {
      node: n,
      parent: brief(n.parentId ? byId.get(n.parentId) : undefined) ?? null,
      children: g.nodes.filter((c) => c.parentId === n.id).map(brief),
      dependsOn: out.filter((e) => e.kind === "depends").map((e) => ({ ...brief(byId.get(e.toNodeId)), label: e.label })),
      usedBy: inc.filter((e) => e.kind === "depends").map((e) => ({ ...brief(byId.get(e.fromNodeId)), label: e.label })),
      implements: out.filter((e) => e.kind === "implements").map((e) => brief(byId.get(e.toNodeId))),
      implementedBy: inc.filter((e) => e.kind === "implements").map((e) => brief(byId.get(e.fromNodeId))),
      flows: g.flows
        .filter((f) => f.steps.some((s) => s.nodeId === n.id))
        .map((f) => ({ id: f.id, name: f.name, step: f.steps.findIndex((s) => s.nodeId === n.id) + 1 })),
      decisions: g.decisions.filter((d) => d.nodeIds.includes(n.id)).map((d) => ({ number: d.number, title: d.title, status: d.status })),
      issues: g.issueLinks.filter((l) => l.nodeId === n.id).map((l) => ({ ref: l.ref, title: l.title })),
    };
  }

  /** Landed content hashes for files matching these anchors: the baseline an explanation is written against. */
  async landedHashesFor(teamId: string, anchors: string[]) {
    if (!anchors.length) return {};
    const files = await this.repo.landedFiles(teamId);
    return Object.fromEntries(files.filter((f) => anchors.some((a) => anchorScore(a, f.path) > 0)).map((f) => [f.path, f.hash]));
  }

  /** Create or update a map node. Agents use names, the UI uses ids. */
  async upsertNode(actor: Actor, teamRef: string, input: NodeInput) {
    const team = await this.access.require(actor, teamRef, "edit");

    // An agent describing code its own session hasn't landed yet: store a draft
    // instead of rewriting the shared map (published when the code lands).
    if (actor.kind === "agent" && !input.forcePublish && (input.id || input.name)) {
      const ref = input.id ?? input.name!;
      const found = await this.resolveNode(team.id, ref, input.layer).catch(() => undefined);
      if (found) {
        const d = await this.sessions.maybeDraft(actor, found, input);
        if (d) return { ...found, ...d };
      }
    }

    const result = await this.db.transaction(async () => {
      let existing: NodeRow | undefined;
      if (input.id) existing = await this.resolveNode(team.id, input.id, input.layer);
      else if (input.name) {
        const rows = await this.repo.findNodes(team.id, { name: input.name.trim(), layer: input.layer });
        if (rows.length > 1) throw new ServiceError("invalid", `"${input.name}" exists on several layers; pass layer`);
        existing = rows[0];
      }

      if (existing) existing = (await this.repo.lockNode(existing.id)) ?? existing;
      if (existing && input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
        throw new ServiceError("conflict", `"${existing.name}" was changed (version ${existing.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: existing });
      }
      const layer: Layer = existing?.layer ?? input.layer ?? "system";
      if (existing && input.layer && input.layer !== existing.layer)
        throw new ServiceError("invalid", `Can't move "${existing.name}" between layers; create a new node and link it with implements`);

      let parentId: string | null | undefined = undefined;
      if (input.parent === null) parentId = null;
      else if (input.parent) {
        const p = await this.resolveNode(team.id, input.parent, layer);
        if (p.layer !== layer) throw new ServiceError("invalid", `Parent must be on the same layer (${layer})`);
        parentId = p.id;
      }
      if (input.kind) checkKind(layer, input.kind);
      if ((input.columns || input.indexes) && layer !== "data")
        throw new ServiceError("invalid", "columns/indexes only apply to data-layer nodes (tables, views, enums)");
      const columns = input.columns?.map(cleanColumn);

      if (existing) {
        if (parentId === existing.id) throw new ServiceError("invalid", "A node cannot be its own parent");
        const reparented = parentId !== undefined && parentId !== existing.parentId;
        const patch = {
          name: input.name?.trim(),
          kind: input.kind,
          parentId,
          summary: input.summary,
          purpose: input.purpose,
          responsibilities: input.responsibilities,
          interfaces: input.interfaces,
          gotchas: input.gotchas,
          details: input.details,
          status: input.status,
          anchors: input.anchors,
          columns,
          indexes: input.indexes,
          // Positions are relative to the parent, so reset when the container changes.
          x: input.x ?? (reparented ? 20 : undefined),
          y: input.y ?? (reparented ? 60 : undefined),
          width: reparented ? null : undefined,
          height: reparented ? null : undefined,
          // An explicit x/y from the caller counts as a person placing it; a reparent resets
          // to the fixed offset above, which is grid-placement again, not a deliberate position.
          placed: input.x !== undefined && input.y !== undefined && !reparented ? true : reparented ? false : undefined,
        };
        const changes = diff(existing as unknown as Record<string, unknown>, patch as Record<string, unknown>);
        const described =
          EXPLAINER_FIELDS.some((f) => f in changes) || "anchors" in changes || "columns" in changes || "indexes" in changes || input.markFresh || input.describedSha;
        const fresh = described
          ? {
              stale: false,
              staleReason: null,
              staleSource: null,
              driftPaths: [],
              describedHashes: input.describedHashes ?? (await this.landedHashesFor(team.id, input.anchors ?? existing.anchors)),
              describedAt: new Date(),
              describedSha: input.describedSha ?? existing.describedSha,
            }
          : {};
        if (!Object.keys(changes).length && !described) return { node: existing, created: false };
        const n = await this.repo.updateNode(existing.id, {
          ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
          ...fresh,
          version: existing.version + 1,
          updatedAt: new Date(),
        });
        const meaningful = Object.keys(changes).filter((k) => !["x", "y", "width", "height"].includes(k));
        if (meaningful.length || (existing.stale && described)) {
          await this.events.emit(actor, team.id, {
            type: "node.updated",
            entity: "node",
            entityId: n.id,
            summary: `updated ${n.layer} ${n.kind} "${n.name}"${meaningful.length ? `: ${meaningful.join(", ")}` : ""}${existing.stale && described ? " (now fresh)" : ""}`,
            data: { name: n.name, layer: n.layer, fields: meaningful },
          });
        }
        return { node: n, created: false, schemaChanged: "columns" in changes || "name" in changes };
      }

      if (!input.name?.trim()) throw new ServiceError("invalid", "name is required to create a node");
      // Auto-place new nodes so agent-created maps are readable without coordinates.
      let { x, y } = input;
      if (x === undefined || y === undefined) {
        const i = await this.repo.siblingCount(team.id, layer, parentId ?? null);
        if (layer === "data" && !parentId) {
          // ERD cards vary in height: stack into 4 columns by accumulated height.
          const placed = await this.repo.dataPlacement(team.id);
          const col = i % 4;
          const inCol = placed.filter((p) => Math.round((p.x - 50) / 320) === col);
          x = 50 + col * 320;
          y = inCol.reduce((m, p) => Math.max(m, p.y + tableHeight(p.columns.length) + 40), 50);
        } else {
          x = parentId ? 20 + (i % 2) * 210 : 50 + (i % 4) * 480;
          y = parentId ? 70 + Math.floor(i / 2) * 100 : 50 + Math.floor(i / 4) * 420;
        }
      }
      const kind = input.kind ?? defaultKind(layer, !!parentId);
      const n = await this.repo.insertNode({
        teamId: team.id,
        workspaceId: team.workspaceId,
        parentId: parentId ?? null,
        layer,
        kind,
        name: input.name.trim(),
        summary: input.summary ?? "",
        purpose: input.purpose ?? "",
        responsibilities: input.responsibilities ?? "",
        interfaces: input.interfaces ?? "",
        gotchas: input.gotchas ?? "",
        details: input.details ?? "",
        status: input.status ?? "planned",
        anchors: input.anchors ?? [],
        columns: columns ?? [],
        indexes: input.indexes ?? [],
        describedHashes: input.describedHashes ?? (await this.landedHashesFor(team.id, input.anchors ?? [])),
        describedSha: input.describedSha ?? null,
        describedAt: new Date(),
        x,
        y,
      });
      await this.events.emit(actor, team.id, {
        type: "node.created",
        entity: "node",
        entityId: n.id,
        summary: `added ${n.layer} ${n.kind} "${n.name}"${parentId ? " (nested)" : ""}`,
        data: { name: n.name, layer: n.layer, kind: n.kind, parentId: n.parentId },
      });
      return { node: n, created: true, schemaChanged: n.layer === "data" };
    });

    for (const target of input.implements ?? []) {
      await this.upsertEdge(actor, team.id, { from: result.node.id, to: target, kind: "implements" });
    }
    if (result.schemaChanged) await this.syncReferences(actor, team.id);
    return result.node;
  }

  // ───────── data layer ─────────

  /**
   * Derive "references" edges from columns' `references: "table.column"`. Columns are the single source of truth: edges are added,
   * updated and removed to match. Returns FK targets that don't exist on the map yet.
   */
  async syncReferences(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef, "edit");
    const tables = await this.repo.dataNodesOf(team.id);
    const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
    const current = (await this.repo.referenceEdgesOf(team.id)).filter((e) => e.meta?.derived);
    const key = (from: string, col: string) => `${from}:${col.toLowerCase()}`;
    const want = new Map<string, { from: NodeRow; to: NodeRow; meta: schema.EdgeMeta }>();
    const unresolved: string[] = [];
    for (const t of tables) {
      for (const c of t.columns) {
        if (!c.references) continue;
        const [tn, cn] = c.references.split(".");
        const target = byName.get(tn.toLowerCase());
        if (!target) {
          unresolved.push(`${t.name}.${c.name} → ${c.references}`);
          continue;
        }
        want.set(key(t.id, c.name), {
          from: t,
          to: target,
          meta: {
            derived: true,
            fromColumn: c.name,
            toColumn: cn,
            // One-to-one only when the FK column alone is unique: a sole PK or a unique column.
            // Part of a composite PK (e.g. a join table) is still many-to-one.
            cardinality: c.unique || (c.pk && t.columns.filter((x) => x.pk).length === 1) ? "1-1" : "n-1",
            ...(c.onDelete ? { onDelete: c.onDelete } : {}),
          },
        });
      }
    }
    let changed = 0;
    await this.db.transaction(async () => {
      for (const e of current) {
        const w = want.get(key(e.fromNodeId, e.meta.fromColumn ?? ""));
        if (!w || w.to.id !== e.toNodeId) {
          await this.repo.deleteEdgeById(e.id);
          changed++;
          continue;
        }
        if (JSON.stringify(w.meta) !== JSON.stringify(e.meta)) {
          await this.repo.updateEdge(e.id, { meta: w.meta, label: `${w.meta.fromColumn} → ${w.meta.toColumn}` });
          changed++;
        }
        want.delete(key(e.fromNodeId, e.meta.fromColumn ?? ""));
      }
      for (const w of want.values()) {
        await this.repo.insertEdge({
          teamId: team.id,
          workspaceId: team.workspaceId,
          fromNodeId: w.from.id,
          toNodeId: w.to.id,
          kind: "references",
          label: `${w.meta.fromColumn} → ${w.meta.toColumn}`,
          meta: w.meta,
        });
        changed++;
      }
      if (changed) {
        await this.events.emit(actor, team.id, {
          type: "schema.relationships",
          entity: "team",
          entityId: team.id,
          summary: `updated ${changed} table relationship${changed === 1 ? "" : "s"}`,
          data: { changed },
        });
      }
    });
    return { changed, unresolved };
  }

  /** Compact data-layer view for agents: tables, columns, relationships. */
  async getSchema(actor: Actor, teamRef: string) {
    const g = await this.getGraph(actor, teamRef);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const tables = g.nodes.filter((n) => n.layer === "data").sort((a, b) => a.name.localeCompare(b.name));
    return {
      tables: tables.map((t) => ({
        name: t.name,
        kind: t.kind,
        summary: t.summary || undefined,
        columns: t.columns,
        indexes: t.indexes.length ? t.indexes : undefined,
        anchors: t.anchors.length ? t.anchors : undefined,
        stale: t.stale || undefined,
        implements: g.edges
          .filter((e) => e.kind === "implements" && e.fromNodeId === t.id)
          .map((e) => `${byId.get(e.toNodeId)?.layer}:${byId.get(e.toNodeId)?.name}`),
      })),
      relationships: g.edges
        .filter((e) => e.kind === "references")
        .map((e) => ({
          from: `${byId.get(e.fromNodeId)?.name}${e.meta.fromColumn ? "." + e.meta.fromColumn : ""}`,
          to: `${byId.get(e.toNodeId)?.name}${e.meta.toColumn ? "." + e.meta.toColumn : ""}`,
          cardinality: e.meta.cardinality,
          onDelete: e.meta.onDelete,
        })),
    };
  }

  /**
   * Bulk position save from the canvas. Layout-only, not logged as events. `placed` marks these positions as deliberately assigned (a
   * drag or resize), so a future auto-layout pass knows to leave them alone; a whole-lens "Tidy" run passes `placed: false` instead,
   * since it's an explicit, visible, user-triggered rearrangement of everything in that lens.
   */
  async saveLayout(actor: Actor, teamRef: string, positions: { id: string; x: number; y: number; width?: number; height?: number }[], opts?: { placed?: boolean }) {
    const team = await this.access.require(actor, teamRef, "edit");
    const placed = opts?.placed ?? true;
    await this.db.transaction(async () => {
      for (const p of positions) {
        await this.repo.setPosition(team.id, p.id, { x: p.x, y: p.y, ...(p.width ? { width: p.width, height: p.height } : {}), placed });
      }
    });
  }

  async deleteNode(actor: Actor, teamRef: string, ref: string) {
    const team = await this.access.require(actor, teamRef, "edit");
    return this.db.transaction(async () => {
      const n = await this.resolveNode(team.id, ref);
      // Remove the subtree (children reference parent_id without an FK).
      const all = await this.repo.nodeParents(team.id);
      const doomed = new Set([n.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const x of all) if (x.parentId && doomed.has(x.parentId) && !doomed.has(x.id)) {
          doomed.add(x.id);
          grew = true;
        }
      }
      await this.repo.deleteNodes([...doomed]);
      await this.events.emit(actor, team.id, {
        type: "node.deleted",
        entity: "node",
        entityId: n.id,
        summary: `removed ${n.layer} ${n.kind} "${n.name}"${doomed.size > 1 ? ` and ${doomed.size - 1} nested` : ""}`,
        data: { name: n.name, layer: n.layer },
      });
      return { ok: true };
    });
  }

  // ───────── edges ─────────

  /** Connect two nodes. `depends`: from uses/calls to. `implements`: from (a lower layer, e.g. code) realizes to (a higher layer, e.g. a system or concept). */
  async upsertEdge(actor: Actor, teamRef: string, input: { from: string; to: string; label?: string; kind?: (typeof schema.EDGE_KINDS)[number] }) {
    const team = await this.access.require(actor, teamRef, "edit");
    const kind = input.kind ?? "depends";
    return this.db.transaction(async () => {
      const from = await this.resolveNode(team.id, input.from);
      const to = await this.resolveNode(team.id, input.to);
      if (from.id === to.id) throw new ServiceError("invalid", "Can't connect a node to itself");
      if (kind === "implements" && LAYER_RANK[from.layer] <= LAYER_RANK[to.layer])
        throw new ServiceError(
          "invalid",
          `implements goes from a lower layer to a higher one (code → data → system → concept); "${from.name}" is ${from.layer}, "${to.name}" is ${to.layer}`,
        );
      if (kind === "references" && (from.layer !== "data" || to.layer !== "data"))
        throw new ServiceError("invalid", "references connects two data-layer tables (set column.references instead to get column-level links)");
      const existing = await this.repo.findEdge(from.id, to.id, kind);
      if (existing) {
        if (input.label === undefined || input.label === existing.label) return existing;
        return this.repo.updateEdge(existing.id, { label: input.label });
      }
      const e = await this.repo.insertEdge({ teamId: team.id, workspaceId: team.workspaceId, fromNodeId: from.id, toNodeId: to.id, kind, label: input.label ?? "" });
      await this.events.emit(actor, team.id, {
        type: "edge.created",
        entity: "edge",
        entityId: e.id,
        summary:
          kind === "implements"
            ? `linked ${from.layer} "${from.name}" implements ${to.layer} "${to.name}"`
            : `connected "${from.name}" → "${to.name}"${e.label ? ` (${e.label})` : ""}`,
        data: { kind, from: from.name, to: to.name },
      });
      return e;
    });
  }

  async deleteEdge(actor: Actor, teamRef: string, edgeId: string) {
    const team = await this.access.require(actor, teamRef, "edit");
    return this.db.transaction(async () => {
      const e = await this.repo.deleteEdgeOf(team.id, edgeId);
      if (!e) return { ok: true };
      const names = await this.repo.nodeNames([e.fromNodeId, e.toNodeId]);
      const name = (id: string) => names.find((n) => n.id === id)?.name ?? "?";
      await this.events.emit(actor, team.id, {
        type: "edge.deleted",
        entity: "edge",
        entityId: e.id,
        summary: `removed ${e.kind === "implements" ? "implements link" : "connection"} "${name(e.fromNodeId)}" → "${name(e.toNodeId)}"`,
        data: { kind: e.kind, from: name(e.fromNodeId), to: name(e.toNodeId) },
      });
      return { ok: true };
    });
  }

  /** Remove a link by endpoints (agent-friendly). */
  async unlinkNodes(actor: Actor, teamRef: string, input: { from: string; to: string; kind?: (typeof schema.EDGE_KINDS)[number] }) {
    const team = await this.access.require(actor, teamRef, "edit");
    const from = await this.resolveNode(team.id, input.from);
    const to = await this.resolveNode(team.id, input.to);
    const found = await this.repo.edgesBetween(from.id, to.id, input.kind);
    for (const e of found) await this.deleteEdge(actor, team.id, e.id); // logged like UI deletes
    return { ok: true, removed: found.length };
  }

  // ───────── flows ─────────

  /** Create or replace a flow (matched by id, else by name). Steps are replaced wholesale. */
  async upsertFlow(actor: Actor, teamRef: string, input: FlowInput) {
    const team = await this.access.require(actor, teamRef, "edit");
    if (!input.name?.trim()) throw new ServiceError("invalid", "Flow name is required");
    return this.db.transaction(async () => {
      const steps: schema.FlowStep[] | undefined = input.steps
        ? await Promise.all(
            input.steps.map(async (s) => ({
              nodeId: (await this.resolveNode(team.id, s.node)).id,
              title: s.title.trim(),
              detail: s.detail ?? "",
            })),
          )
        : undefined;
      // A second edit from the same version waits on this lock, then sees the first one's version and is refused.
      const existing = await this.repo.findFlow(team.id, input.id && isUuid(input.id) ? { id: input.id } : { name: (input.id ?? input.name).trim() }, true);
      if (existing) {
        if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
          throw new ServiceError("conflict", `Flow "${existing.name}" was changed (version ${existing.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: existing });
        }
        const f = await this.repo.updateFlow(existing.id, {
          name: input.name.trim(),
          description: input.description ?? existing.description,
          steps: steps ?? existing.steps,
          version: existing.version + 1,
          updatedAt: new Date(),
        });
        await this.events.emit(actor, team.id, { type: "flow.updated", entity: "flow", entityId: f.id, summary: `updated flow "${f.name}" (${f.steps.length} steps)`, data: { name: f.name } });
        return f;
      }
      const f = await this.repo.insertFlow({ teamId: team.id, workspaceId: team.workspaceId, name: input.name.trim(), description: input.description ?? "", steps: steps ?? [] });
      await this.events.emit(actor, team.id, { type: "flow.created", entity: "flow", entityId: f.id, summary: `added flow "${f.name}" (${f.steps.length} steps)`, data: { name: f.name } });
      return f;
    });
  }

  async deleteFlow(actor: Actor, teamRef: string, ref: string) {
    const team = await this.access.require(actor, teamRef, "edit");
    const f = await this.repo.findFlow(team.id, isUuid(ref) ? { id: ref } : { name: ref });
    if (!f) throw new ServiceError("not_found", `Flow "${ref}" not found`);
    await this.repo.deleteFlow(f.id);
    await this.events.emit(actor, team.id, { type: "flow.deleted", entity: "flow", entityId: f.id, summary: `removed flow "${f.name}"` });
    return { ok: true };
  }

  // ───────── the web app's bodies ─────────

  /** Create (no id) or change (id) a node. With `version`, a change made by anyone since is a 409 and nothing is overwritten. */
  upsertNodeAs(actor: Actor, teamKey: string, b: Body & { id?: string }) {
    const input = nodeInput(b);
    const id = text(b, "id");
    if (id !== undefined) input.id = id;
    const version = whole(b, "version");
    if (version !== undefined) input.expectedVersion = version;
    if (!id && !input.name) bad("name", "name is required to create a node");
    return this.upsertNode(actor, teamKey, input) as Promise<NodeRow>;
  }

  /** Positions (and sizes) of many nodes at once, from a drag, a resize or a Tidy. `placed` says whether a person placed them. */
  async saveLayoutAs(actor: Actor, teamKey: string, b: Body) {
    const { positions, placed } = layoutInput(b);
    await this.saveLayout(actor, teamKey, positions, placed === undefined ? undefined : { placed });
    return { ok: true as const };
  }

  /** A connection between two nodes, by id (or name). `depends` within a layer, `implements` from a lower layer to a higher one. */
  connectAs(actor: Actor, teamKey: string, b: Body) {
    const from = text(b, "from", { required: true });
    const to = text(b, "to", { required: true });
    const kind = oneOf(b, "kind", ["depends", "implements"] as const) ?? "depends";
    const label = text(b, "label", { max: 200 });
    return this.upsertEdge(actor, teamKey, { from: from!, to: to!, label, kind });
  }

  upsertFlowAs(actor: Actor, teamKey: string, b: Body) {
    const name = text(b, "name", { required: true, max: 200, trim: true })!;
    let steps: FlowInput["steps"];
    if (b.steps !== undefined) {
      if (!Array.isArray(b.steps) || b.steps.length > 200) return bad("steps", "steps must be a list (at most 200)");
      steps = b.steps.map((s, i) => {
        const o = s as Body;
        if (!o || typeof o !== "object") return bad("steps", `step ${i + 1} must be an object`);
        return { node: text(o, "node", { required: true }) ?? bad("steps", `step ${i + 1} needs a node`), title: text(o, "title", { required: true, max: 500 }) ?? "", detail: text(o, "detail", { max: 20_000 }) };
      });
    }
    const input: FlowInput = { name, description: text(b, "description", { max: 5000 }), steps, expectedVersion: whole(b, "version") };
    const id = text(b, "id");
    if (id !== undefined) input.id = id;
    return this.upsertFlow(actor, teamKey, input);
  }
}
