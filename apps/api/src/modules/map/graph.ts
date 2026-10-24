import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../lib/service-error";
import { withNodeIds } from "../../lib/links";
import { Q, diff, emit, isUuid, lockRow } from "../../lib/service-core";
import { anchorScore } from "./freshness";
import { requireTeam } from "../teams/teams";

const { issues, nodes, edges, issueNodes, flows, decisions, terms } = schema;

// ───────────────────────── knowledge map ─────────────────────────
//
// One linked model at three zoom levels (concept → system → code). `depends`
// edges connect nodes within a level; `implements` edges connect a lower level
// to the higher-level thing it realizes. Flows, decisions and the glossary hang
// off nodes. Anchors + reported file changes keep the explanations honest.

export type NodeRow = typeof nodes.$inferSelect;
export type Layer = schema.Layer;

export const LAYER_RANK: Record<Layer, number> = { concept: 0, system: 1, data: 2, code: 3 };

export async function getGraph(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const ns = await db.select().from(nodes).where(eq(nodes.teamId, team.id));
  const es = await db.select().from(edges).where(eq(edges.teamId, team.id));
  const nodeIds = ns.map((n) => n.id);
  const links = nodeIds.length
    ? await db
        .select({ nodeId: issueNodes.nodeId, issueId: issues.id, number: issues.number, title: issues.title, statusId: issues.statusId })
        .from(issueNodes)
        .innerJoin(issues, eq(issues.id, issueNodes.issueId))
        .where(inArray(issueNodes.nodeId, nodeIds))
    : [];
  const fl = await db.select().from(flows).where(eq(flows.teamId, team.id)).orderBy(asc(flows.name));
  const ds = await db.select().from(decisions).where(eq(decisions.teamId, team.id)).orderBy(asc(decisions.number));
  const ts = await db.select().from(terms).where(eq(terms.teamId, team.id)).orderBy(asc(terms.term));
  const alive = new Set(nodeIds);
  return {
    team,
    nodes: ns,
    edges: es,
    issueLinks: links.map((l) => ({ ...l, ref: `${team.key}-${l.number}` })),
    flows: fl.map((f) => ({ ...f, steps: f.steps.filter((s) => alive.has(s.nodeId)) })),
    decisions: (await withNodeIds(db, ds)).map((d) => ({ ...d, nodeIds: d.nodeIds.filter((id) => alive.has(id)) })),
    terms: ts,
    // Nodes whose files are being changed in active sessions, and pending drafts.
    flux: await (await import("./sync")).fluxForTeam(team.id),
  };
}

/**
 * Resolve a node by uuid or name (case-insensitive). Names may repeat across
 * layers ("Billing" concept vs "billing" service), so pass `layer` or use the
 * "layer:name" form to disambiguate.
 */
export async function resolveNode(q: Q, teamId: string, ref: string, layer?: Layer) {
  let name = ref.trim();
  const m = /^(concept|system|data|code):(.+)$/i.exec(name);
  if (m) {
    layer = m[1].toLowerCase() as Layer;
    name = m[2].trim();
  }
  const rows = await q
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.teamId, teamId),
        isUuid(name) ? eq(nodes.id, name) : eq(sql`lower(${nodes.name})`, name.toLowerCase()),
        layer && !isUuid(name) ? eq(nodes.layer, layer) : undefined,
      ),
    );
  if (!rows.length) throw new ServiceError("not_found", `Node "${ref}" not found`);
  if (rows.length > 1)
    throw new ServiceError(
      "invalid",
      `"${ref}" is ambiguous (${rows.map((r) => `${r.layer}:${r.name}`).join(", ")}). Prefix with the layer, e.g. "${rows[0].layer}:${rows[0].name}".`,
    );
  return rows[0];
}

/** Everything about one node: explainer, neighbours on every layer, flows, decisions, issues. */
export async function getNode(actor: Actor, teamRef: string, ref: string) {
  const g = await getGraph(actor, teamRef);
  const db = await getDb();
  const n = await resolveNode(db, g.team.id, ref);
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
    decisions: g.decisions
      .filter((d) => d.nodeIds.includes(n.id))
      .map((d) => ({ number: d.number, title: d.title, status: d.status })),
    issues: g.issueLinks.filter((l) => l.nodeId === n.id).map((l) => ({ ref: l.ref, title: l.title })),
  };
}

export type NodeInput = {
  id?: string; // update when given (uuid or name)
  name?: string;
  layer?: Layer;
  kind?: (typeof schema.NODE_KINDS)[number];
  parent?: string | null; // parent node uuid or name (same layer); null = top level
  summary?: string;
  purpose?: string;
  responsibilities?: string;
  interfaces?: string;
  gotchas?: string;
  details?: string;
  status?: "planned" | "building" | "live" | "deprecated";
  anchors?: string[];
  describedSha?: string;
  markFresh?: boolean;
  implements?: string[]; // higher-layer nodes this one realizes
  columns?: schema.Column[]; // data layer only
  indexes?: schema.Index[]; // data layer only
  forcePublish?: boolean; // skip the in-flux draft check (landing, human publish)
  /** Optimistic lock: the node version the caller last read. A different current version is a 409 and nothing changes. The web app sends it; agents' tools do not. */
  expectedVersion?: number;
  describedHashes?: Record<string, string>; // content hashes the explanation was written against
  x?: number;
  y?: number;
};

export const EXPLAINER_FIELDS = ["summary", "purpose", "responsibilities", "interfaces", "gotchas", "details"] as const;

export function defaultKind(layer: Layer, hasParent: boolean): (typeof schema.NODE_KINDS)[number] {
  if (layer === "concept") return hasParent ? "capability" : "concept";
  if (layer === "code") return hasParent ? "file" : "directory";
  if (layer === "data") return "table";
  return hasParent ? "module" : "service";
}

export function checkKind(layer: Layer, kind: string) {
  const allowed = schema.KINDS_BY_LAYER[layer] as readonly string[];
  if (!allowed.includes(kind))
    throw new ServiceError("invalid", `kind "${kind}" isn't valid on the ${layer} layer (use: ${allowed.join(", ")})`);
}

/** Create or update a map node. Agents use names, the UI uses ids. */
export async function upsertNode(actor: Actor, teamRef: string, input: NodeInput) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");

  // An agent describing code its own session hasn't landed yet: store a draft
  // instead of rewriting the shared map (published when the code lands).
  if (actor.kind === "agent" && !input.forcePublish && (input.id || input.name)) {
    const ref = input.id ?? input.name!;
    const found = await resolveNode(db, team.id, ref, input.layer).catch(() => undefined);
    if (found) {
      const { maybeDraft } = await import("./sync");
      const d = await maybeDraft(actor, found, input);
      if (d) return { ...found, ...d };
    }
  }

  const result = await db.transaction(async (tx) => {
    let existing: NodeRow | undefined;
    if (input.id) existing = await resolveNode(tx, team.id, input.id, input.layer);
    else if (input.name) {
      const rows = await tx
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.teamId, team.id),
            eq(sql`lower(${nodes.name})`, input.name.trim().toLowerCase()),
            input.layer ? eq(nodes.layer, input.layer) : undefined,
          ),
        );
      if (rows.length > 1) throw new ServiceError("invalid", `"${input.name}" exists on several layers; pass layer`);
      existing = rows[0];
    }

    if (existing) existing = await lockRow(tx, nodes, existing);
    if (existing && input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw new ServiceError("conflict", `"${existing.name}" was changed (version ${existing.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: existing });
    }
    const layer: Layer = existing?.layer ?? input.layer ?? "system";
    if (existing && input.layer && input.layer !== existing.layer)
      throw new ServiceError("invalid", `Can't move "${existing.name}" between layers; create a new node and link it with implements`);

    let parentId: string | null | undefined = undefined;
    if (input.parent === null) parentId = null;
    else if (input.parent) {
      const p = await resolveNode(tx, team.id, input.parent, layer);
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
            describedHashes: input.describedHashes ?? (await landedHashesFor(tx, team.id, input.anchors ?? existing.anchors)),
            describedAt: new Date(),
            describedSha: input.describedSha ?? existing.describedSha,
          }
        : {};
      if (!Object.keys(changes).length && !described) return { node: existing, created: false };
      const [n] = await tx
        .update(nodes)
        .set({
          ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
          ...fresh,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(nodes.id, existing.id))
        .returning();
      const meaningful = Object.keys(changes).filter((k) => !["x", "y", "width", "height"].includes(k));
      if (meaningful.length || (existing.stale && described)) {
        await emit(tx, actor, team.id, {
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
      const siblings = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.teamId, team.id),
            eq(nodes.layer, layer),
            parentId ? eq(nodes.parentId, parentId) : sql`${nodes.parentId} is null`,
          ),
        );
      const i = siblings.length;
      if (layer === "data" && !parentId) {
        // ERD cards vary in height: stack into 4 columns by accumulated height.
        const placed = await tx
          .select({ x: nodes.x, y: nodes.y, columns: nodes.columns })
          .from(nodes)
          .where(and(eq(nodes.teamId, team.id), eq(nodes.layer, "data")));
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
    const [n] = await tx
      .insert(nodes)
      .values({
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
        describedHashes: input.describedHashes ?? (await landedHashesFor(tx, team.id, input.anchors ?? [])),
        describedSha: input.describedSha ?? null,
        describedAt: new Date(),
        x,
        y,
      })
      .returning();
    await emit(tx, actor, team.id, {
      type: "node.created",
      entity: "node",
      entityId: n.id,
      summary: `added ${n.layer} ${n.kind} "${n.name}"${parentId ? " (nested)" : ""}`,
      data: { name: n.name, layer: n.layer, kind: n.kind, parentId: n.parentId },
    });
    return { node: n, created: true, schemaChanged: n.layer === "data" };
  });

  for (const target of input.implements ?? []) {
    await upsertEdge(actor, team.id, { from: result.node.id, to: target, kind: "implements" });
  }
  if (result.schemaChanged) await syncReferences(actor, team.id);
  return result.node;
}

/** Landed content hashes for files matching these anchors: the baseline an explanation is written against. */
export async function landedHashesFor(q: Q, teamId: string, anchors: string[]) {
  if (!anchors.length) return {};
  const files = await q.select({ path: schema.teamFiles.path, hash: schema.teamFiles.hash }).from(schema.teamFiles).where(eq(schema.teamFiles.teamId, teamId));
  return Object.fromEntries(files.filter((f) => anchors.some((a) => anchorScore(a, f.path) > 0)).map((f) => [f.path, f.hash]));
}

// ───────── data layer ─────────

/** Rendered height of an ERD card, shared with the canvas so auto-placement doesn't overlap. */
export const tableHeight = (columns: number) => 48 + Math.max(1, columns) * 22;

export function cleanColumn(c: schema.Column): schema.Column {
  if (!c.name?.trim()) throw new ServiceError("invalid", "Every column needs a name");
  const out: schema.Column = { name: c.name.trim(), type: (c.type ?? "").trim() };
  if (c.nullable) out.nullable = true;
  if (c.pk) out.pk = true;
  if (c.unique) out.unique = true;
  if (c.default) out.default = c.default;
  if (c.references?.trim()) {
    if (!/^[^.\s]+\.[^.\s]+$/.test(c.references.trim()))
      throw new ServiceError("invalid", `Column "${c.name}": references must look like "table.column"`);
    out.references = c.references.trim();
  }
  if (c.onDelete) out.onDelete = c.onDelete;
  if (c.note) out.note = c.note;
  return out;
}

/**
 * Derive "references" edges from columns' `references: "table.column"`.
 * Columns are the single source of truth: edges are added, updated and removed
 * to match. Returns FK targets that don't exist on the map yet.
 */
export async function syncReferences(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const tables = await db.select().from(nodes).where(and(eq(nodes.teamId, team.id), eq(nodes.layer, "data")));
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const current = (await db.select().from(edges).where(and(eq(edges.teamId, team.id), eq(edges.kind, "references")))).filter(
    (e) => e.meta?.derived,
  );
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
  await db.transaction(async (tx) => {
    for (const e of current) {
      const w = want.get(key(e.fromNodeId, e.meta.fromColumn ?? ""));
      if (!w || w.to.id !== e.toNodeId) {
        await tx.delete(edges).where(eq(edges.id, e.id));
        changed++;
        continue;
      }
      if (JSON.stringify(w.meta) !== JSON.stringify(e.meta)) {
        await tx.update(edges).set({ meta: w.meta, label: `${w.meta.fromColumn} → ${w.meta.toColumn}` }).where(eq(edges.id, e.id));
        changed++;
      }
      want.delete(key(e.fromNodeId, e.meta.fromColumn ?? ""));
    }
    for (const w of want.values()) {
      await tx.insert(edges).values({
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
      await emit(tx, actor, team.id, {
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
export async function getSchema(actor: Actor, teamRef: string) {
  const g = await getGraph(actor, teamRef);
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
 * Bulk position save from the canvas. Layout-only, not logged as events.
 * `placed` marks these positions as deliberately assigned (a drag or resize), so a future
 * auto-layout pass knows to leave them alone; a whole-lens "Tidy" run passes `placed: false`
 * instead, since it's an explicit, visible, user-triggered rearrangement of everything in that lens.
 */
export async function saveLayout(
  actor: Actor,
  teamRef: string,
  positions: { id: string; x: number; y: number; width?: number; height?: number }[],
  opts?: { placed?: boolean },
) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const placed = opts?.placed ?? true;
  await db.transaction(async (tx) => {
    for (const p of positions) {
      await tx
        .update(nodes)
        .set({ x: p.x, y: p.y, ...(p.width ? { width: p.width, height: p.height } : {}), placed })
        .where(and(eq(nodes.id, p.id), eq(nodes.teamId, team.id)));
    }
  });
}

export async function deleteNode(actor: Actor, teamRef: string, ref: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  return db.transaction(async (tx) => {
    const n = await resolveNode(tx, team.id, ref);
    // Remove the subtree (children reference parent_id without an FK).
    const all = await tx.select({ id: nodes.id, parentId: nodes.parentId }).from(nodes).where(eq(nodes.teamId, team.id));
    const doomed = new Set([n.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of all) if (x.parentId && doomed.has(x.parentId) && !doomed.has(x.id)) {
        doomed.add(x.id);
        grew = true;
      }
    }
    await tx.delete(nodes).where(inArray(nodes.id, [...doomed]));
    await emit(tx, actor, team.id, {
      type: "node.deleted",
      entity: "node",
      entityId: n.id,
      summary: `removed ${n.layer} ${n.kind} "${n.name}"${doomed.size > 1 ? ` and ${doomed.size - 1} nested` : ""}`,
      data: { name: n.name, layer: n.layer },
    });
    return { ok: true };
  });
}

/**
 * Connect two nodes. `depends`: from uses/calls to. `implements`: from (a lower
 * layer, e.g. code) realizes to (a higher layer, e.g. a system or concept).
 */
export async function upsertEdge(
  actor: Actor,
  teamRef: string,
  input: { from: string; to: string; label?: string; kind?: (typeof schema.EDGE_KINDS)[number] },
) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const kind = input.kind ?? "depends";
  return db.transaction(async (tx) => {
    const from = await resolveNode(tx, team.id, input.from);
    const to = await resolveNode(tx, team.id, input.to);
    if (from.id === to.id) throw new ServiceError("invalid", "Can't connect a node to itself");
    if (kind === "implements" && LAYER_RANK[from.layer] <= LAYER_RANK[to.layer])
      throw new ServiceError(
        "invalid",
        `implements goes from a lower layer to a higher one (code → data → system → concept); "${from.name}" is ${from.layer}, "${to.name}" is ${to.layer}`,
      );
    if (kind === "references" && (from.layer !== "data" || to.layer !== "data"))
      throw new ServiceError("invalid", "references connects two data-layer tables (set column.references instead to get column-level links)");
    const [existing] = await tx
      .select()
      .from(edges)
      .where(and(eq(edges.fromNodeId, from.id), eq(edges.toNodeId, to.id), eq(edges.kind, kind)));
    if (existing) {
      if (input.label === undefined || input.label === existing.label) return existing;
      const [e] = await tx.update(edges).set({ label: input.label }).where(eq(edges.id, existing.id)).returning();
      return e;
    }
    const [e] = await tx
      .insert(edges)
      .values({ teamId: team.id, workspaceId: team.workspaceId, fromNodeId: from.id, toNodeId: to.id, kind, label: input.label ?? "" })
      .returning();
    await emit(tx, actor, team.id, {
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

export async function deleteEdge(actor: Actor, teamRef: string, edgeId: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  return db.transaction(async (tx) => {
    const [e] = await tx.delete(edges).where(and(eq(edges.id, edgeId), eq(edges.teamId, team.id))).returning();
    if (!e) return { ok: true };
    const names = await tx.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, [e.fromNodeId, e.toNodeId]));
    const name = (id: string) => names.find((n) => n.id === id)?.name ?? "?";
    await emit(tx, actor, team.id, {
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
export async function unlinkNodes(actor: Actor, teamRef: string, input: { from: string; to: string; kind?: (typeof schema.EDGE_KINDS)[number] }) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const from = await resolveNode(db, team.id, input.from);
  const to = await resolveNode(db, team.id, input.to);
  const found = await db
    .select({ id: edges.id })
    .from(edges)
    .where(and(eq(edges.fromNodeId, from.id), eq(edges.toNodeId, to.id), input.kind ? eq(edges.kind, input.kind) : undefined));
  for (const e of found) await deleteEdge(actor, team.id, e.id); // logged like UI deletes
  return { ok: true, removed: found.length };
}

// ───────── flows ─────────

export type FlowInput = {
  id?: string;
  name: string;
  description?: string;
  steps?: { node: string; title: string; detail?: string }[];
  /** Optimistic lock, as on nodes: the flow version the caller last read. */
  expectedVersion?: number;
};

/** Create or replace a flow (matched by id, else by name). Steps are replaced wholesale. */
export async function upsertFlow(actor: Actor, teamRef: string, input: FlowInput) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  if (!input.name?.trim()) throw new ServiceError("invalid", "Flow name is required");
  return db.transaction(async (tx) => {
    const steps: schema.FlowStep[] | undefined = input.steps
      ? await Promise.all(
          input.steps.map(async (s) => ({
            nodeId: (await resolveNode(tx, team.id, s.node)).id,
            title: s.title.trim(),
            detail: s.detail ?? "",
          })),
        )
      : undefined;
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(
          eq(flows.teamId, team.id),
          input.id && isUuid(input.id) ? eq(flows.id, input.id) : eq(sql`lower(${flows.name})`, (input.id ?? input.name).trim().toLowerCase()),
        ),
      )
      .for("update"); // a second edit from the same version waits here, then sees the first one's version and is refused
    if (existing) {
      if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
        throw new ServiceError("conflict", `Flow "${existing.name}" was changed (version ${existing.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: existing });
      }
      const [f] = await tx
        .update(flows)
        .set({
          name: input.name.trim(),
          description: input.description ?? existing.description,
          steps: steps ?? existing.steps,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(flows.id, existing.id))
        .returning();
      await emit(tx, actor, team.id, { type: "flow.updated", entity: "flow", entityId: f.id, summary: `updated flow "${f.name}" (${f.steps.length} steps)`, data: { name: f.name } });
      return f;
    }
    const [f] = await tx
      .insert(flows)
      .values({ teamId: team.id, workspaceId: team.workspaceId, name: input.name.trim(), description: input.description ?? "", steps: steps ?? [] })
      .returning();
    await emit(tx, actor, team.id, { type: "flow.created", entity: "flow", entityId: f.id, summary: `added flow "${f.name}" (${f.steps.length} steps)`, data: { name: f.name } });
    return f;
  });
}

export async function deleteFlow(actor: Actor, teamRef: string, ref: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const [f] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.teamId, team.id), isUuid(ref) ? eq(flows.id, ref) : eq(sql`lower(${flows.name})`, ref.toLowerCase())));
  if (!f) throw new ServiceError("not_found", `Flow "${ref}" not found`);
  await db.delete(flows).where(eq(flows.id, f.id));
  await emit(db, actor, team.id, { type: "flow.deleted", entity: "flow", entityId: f.id, summary: `removed flow "${f.name}"` });
  return { ok: true };
}
