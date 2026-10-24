import { Inject, Injectable } from "@nestjs/common";
import { getDocTemplate, listDocTemplates as listDocTemplatesStatic, DOC_TEMPLATE_IDS } from "@wheelhouse/shared/doc-templates";
import type { Actor } from "../../common/actor";
import { cleanLabels } from "../../common/labels";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { bad, oneOf, text, textList, textOrNull, whole } from "../../lib/web-input";
import { Database } from "../../platform/database/database";
import { diff } from "../../platform/events/emit";
import { EventsService } from "../../platform/events/events.service";
import { GraphService, SessionsService, anchoredBy } from "../map/index";
import type { Human } from "../auth/index";
import { TeamAccessService } from "../teams/index";
import { DocsRepository, type DocRow } from "./docs.repository";
import { DOC_BODY_MAX_BYTES, DOC_MAX_DEPTH, DOC_MAX_PER_TEAM, canWriteDocs, clipText, extractPathTokens, slugifyDoc } from "./docs.rules";

export type { DocRow } from "./docs.repository";

export type DocInput = {
  title?: string;
  body?: string;
  parent?: string | null; // parent doc ref (uuid or slug path); null = top level
  slug?: string; // explicit slug override; defaults to slugify(title)
  anchors?: string[]; // author-confirmed file paths/globs this doc describes (WH-64 freshness)
  describedSha?: string;
  markFresh?: boolean; // clear stale without changing title/body, recording who confirmed via updatedByKind/updatedById
  template?: string; // WH-65: template id to seed `body` from on create, if no explicit body is given
};

export type DocUpdateInput = Pick<DocInput, "title" | "body" | "anchors" | "describedSha" | "markFresh"> & {
  labels?: string[]; // WH-103: free-text tags; they never affect freshness
  forcePublish?: boolean; // skip the in-flux draft check (used when publishing a draft on land)
  describedHashes?: Record<string, string>; // content hashes the edit/confirmation was made against
};

type Body = Record<string, unknown>;

const DOC_PATCH_KEYS = ["title", "body", "anchors"] as const;

/** Labels as stored: trimmed, no empties or repeats (case-insensitively, first spelling wins), at most 20 of at most 40 characters. */
const cleanDocLabels = (labels: string[]) => cleanLabels(labels, "doc");

/**
 * Workspace documentation (WH-51): markdown docs stored in Wheelhouse, next to the board and map. A tree via parentId, optimistic
 * locking like issues, soft delete (30-day purge; history lives in `events`). Reading is open to any key; writing requires a human
 * actor or a key with the "docs:write" capability, checked here and again at the tool layer. Every method resolves the team through
 * TeamAccessService, so another workspace's team, doc or node is "not found".
 *
 * The `...As` methods take the request body as the web app sends it and check it; the controller maps the answers with the presenter.
 */
@Injectable()
export class DocsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DocsRepository) private readonly repo: DocsRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  // ───────── access and lookups ─────────

  async assertDocsWritable(actor: Actor) {
    if (actor.kind === "human") return;
    if (!canWriteDocs(actor, await this.repo.keyCapabilities(actor.id))) {
      throw new ServiceError("forbidden", 'This API key cannot write docs. Ask a teammate to grant it the "docs:write" capability, or write docs as a human.');
    }
  }

  /** Accepts a doc uuid, or a "slug" / "parent-slug/slug" path, scoped to one team. Never returns a soft-deleted doc. */
  async resolveDoc(teamId: string, ref: string): Promise<DocRow> {
    if (isUuid(ref)) {
      const d = await this.repo.findDocById(teamId, ref);
      if (!d) throw new ServiceError("not_found", `Doc ${ref} not found`);
      return d;
    }
    // Walk a "/"-separated slug path from the root.
    const parts = ref.split("/").filter(Boolean);
    if (!parts.length) throw new ServiceError("invalid", "Doc ref is required");
    let parentId: string | null = null;
    let found: DocRow | undefined;
    for (const slug of parts) {
      const d = await this.repo.findDocBySlug(teamId, parentId, slug);
      if (!d) throw new ServiceError("not_found", `Doc "${ref}" not found`);
      found = d;
      parentId = d.id;
    }
    return found!;
  }

  /** Depth of `parentId` itself (root = 0), by walking up its own ancestor chain. */
  private async depthOf(teamId: string, parentId: string | null): Promise<number> {
    let depth = 0;
    let cur = parentId;
    while (cur) {
      const p = await this.repo.parentOf(cur, teamId);
      if (!p) break;
      cur = p.parentId;
      if (cur) depth += 1; // only count a hop to another ancestor, not the starting node itself
      if (depth > DOC_MAX_DEPTH + 1) break; // guard against a cycle somehow sneaking in
    }
    return depth;
  }

  private async uniqueSlug(teamId: string, parentId: string | null, base: string, excludeId?: string) {
    let slug = base;
    for (let i = 1; i < 50; i++) {
      if (!(await this.repo.slugTaken(teamId, parentId, slug, excludeId))) return slug;
      slug = `${base}-${i + 1}`;
    }
    throw new ServiceError("conflict", `Could not find a free slug for "${base}"`);
  }

  // ───────── reads ─────────

  /**
   * Candidate anchors for a doc: path-like tokens found in its body, plus the anchors of
   * any map nodes it's linked to. Never applied automatically — surfaced for the author
   * to accept/reject (upsert_doc / the docs UI pass `anchors` explicitly to confirm them).
   */
  async suggestDocAnchors(actor: Actor, teamRef: string, ref: string): Promise<string[]> {
    const team = await this.access.require(actor, teamRef);
    const d = await this.resolveDoc(team.id, ref);
    const fromBody = extractPathTokens(d.body);
    const linkedNodeIds = await this.repo.linkedNodeIds(d.id);
    const fromNodes = linkedNodeIds.length ? (await this.repo.nodeAnchors(linkedNodeIds.map((x) => x.nodeId))).flatMap((n) => n.anchors) : [];
    return [...new Set([...fromBody, ...fromNodes])].filter((a) => !d.anchors.includes(a));
  }

  /** Static list of the doc templates (id/name/description, no bodies) — no DB access needed. */
  listDocTemplates() {
    return listDocTemplatesStatic();
  }

  /** The tree of a team's (non-deleted) docs: id, slug, title, parentId, position, updatedAt. */
  async listDocs(actor: Actor, teamRef: string, parentRef?: string) {
    const team = await this.access.require(actor, teamRef);
    const parentId = parentRef ? (await this.resolveDoc(team.id, parentRef)).id : undefined;
    const rows = await this.repo.listLiveDocs(team.id);
    if (parentRef !== undefined) return rows.filter((d) => d.parentId === parentId);
    return rows;
  }

  async getDoc(actor: Actor, teamRef: string, ref: string) {
    const team = await this.access.require(actor, teamRef);
    const d = await this.resolveDoc(team.id, ref);
    const linked = await this.repo.nodesLinkedTo(d.id);
    // Who wrote it (WH-103): the owner is whoever created the doc; contributors are everyone else who changed it, from the event log
    // (which keeps the name they had at the time, so an agent or a person who has left still has one).
    const touched = await this.repo.docWriters(team.workspaceId, d.id);
    const created = touched.find((e) => e.type === "doc.created");
    const ownerName = (d.createdByKind === "human" && d.createdById ? await this.repo.userName(d.createdById) : undefined) ?? created?.actorName ?? (d.createdByKind === "agent" ? "Agent" : "Someone");
    const seenPeople = new Set([`${d.createdByKind}:${d.createdById}`]);
    const contributors: { kind: "human" | "agent"; id: string | null; name: string }[] = [];
    for (const e of touched) {
      const k = `${e.actorKind}:${e.actorId}`;
      if (seenPeople.has(k)) continue;
      seenPeople.add(k);
      contributors.push({ kind: e.actorKind, id: e.actorId, name: e.actorName });
    }
    return { doc: d, nodes: linked, owner: { kind: d.createdByKind, id: d.createdById, name: ownerName }, contributors };
  }

  /** The docs page in one read: the tree, and what its side panels offer (map nodes to link, decisions to link, who wrote what). */
  async docsIndex(h: Human, teamKey: string) {
    const [docs, g, members] = await Promise.all([this.listDocs(h.actor, teamKey), this.graph.getGraph(h.actor, teamKey), this.repo.workspaceMembers(h.workspace.id)]);
    return { docs, nodes: g.nodes, decisions: g.decisions, members };
  }

  /** Short index for the briefing: titles + slugs only, never bodies (protects the token budget). */
  async listDocsIndex(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    return this.repo.liveDocTitles(team.id);
  }

  /** Full-text search over doc title + body, ranked by ts_rank, with snippets, within a token budget. */
  async searchDocs(actor: Actor, teamRef: string, query: string, opts: { maxTokens?: number } = {}) {
    const team = await this.access.require(actor, teamRef);
    const q = query.trim();
    if (!q) throw new ServiceError("invalid", "query is required");
    // `max_tokens` is approximated from characters (~4 chars/token, the rule of thumb the briefing budget uses) so results fit an agent's context budget.
    const maxChars = Math.min(Math.max((opts.maxTokens ?? 800) * 4, 400), 80_000);
    const rows = await this.repo.searchDocs(team.id, q);

    const out: { slug: string; title: string; snippet: string; updatedAt: Date; rank: number }[] = [];
    let used = 0;
    for (const r of rows) {
      const snippet = r.snippet || clipText(r.body, 240);
      const cost = r.title.length + snippet.length + 20;
      if (used + cost > maxChars && out.length) break;
      out.push({ slug: r.slug, title: r.title, snippet, updatedAt: r.updatedAt, rank: r.rank });
      used += cost;
      if (used > maxChars) break;
    }
    return { query: q, results: out, truncated: out.length < rows.length };
  }

  // ───────── writes ─────────

  async createDoc(actor: Actor, teamRef: string, input: DocInput & { title: string }): Promise<DocRow> {
    const team = await this.access.require(actor, teamRef, "edit");
    await this.assertDocsWritable(actor);
    if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
    // WH-65: explicit body always wins; the template is only a convenience default for a blank doc.
    const body = input.body ?? getDocTemplate(input.template)?.body ?? "";
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > DOC_BODY_MAX_BYTES) throw new ServiceError("invalid", `Doc body is ${bodyBytes} bytes; the limit is ${DOC_BODY_MAX_BYTES} (200 KB)`);

    return this.db.transaction(async () => {
      const parentId = input.parent === null || input.parent === undefined ? null : (await this.resolveDoc(team.id, input.parent)).id;
      const depth = await this.depthOf(team.id, parentId);
      if (depth + 1 > DOC_MAX_DEPTH) throw new ServiceError("invalid", `Docs can nest at most ${DOC_MAX_DEPTH} levels deep`);
      if ((await this.repo.liveDocCount(team.id)) >= DOC_MAX_PER_TEAM) throw new ServiceError("invalid", `This team already has ${DOC_MAX_PER_TEAM} docs, the limit`);

      const base = slugifyDoc(input.slug ?? input.title);
      const slug = await this.uniqueSlug(team.id, parentId, base);
      const siblings = await this.repo.siblingPositions(team.id, parentId);
      const position = siblings.length ? Math.max(...siblings.map((s) => s.position)) + 1000 : 1000;

      const anchors = input.anchors ?? [];
      const d = await this.repo.insertDoc({
        teamId: team.id,
        workspaceId: team.workspaceId,
        parentId,
        slug,
        title: input.title.trim(),
        body,
        position,
        anchors,
        describedHashes: await this.graph.landedHashesFor(team.id, anchors),
        describedSha: input.describedSha ?? null,
        describedAt: new Date(),
        createdByKind: actor.kind,
        createdById: actor.id,
        updatedByKind: actor.kind,
        updatedById: actor.id,
      });
      await this.events.emit(actor, team.id, {
        type: "doc.created",
        entity: "doc",
        entityId: d.id,
        summary: `created doc "${d.title}"`,
        data: { slug: d.slug, title: d.title },
      });
      return d;
    });
  }

  /**
   * Patch a doc's title/body/anchors, or just confirm it's still accurate (markFresh).
   * Pass `expectedVersion` for optimistic locking, same pattern as updateIssue.
   *
   * Mirrors upsertNode: an agent session editing a doc whose anchored files are still
   * in flux (changed in that same session, not landed) gets the edit stored as a
   * doc_drafts row instead of applied directly — published when land() processes
   * those files (WH-64 scope E).
   */
  async updateDoc(actor: Actor, teamRef: string, ref: string, patch: DocUpdateInput, expectedVersion?: number): Promise<DocRow> {
    const team = await this.access.require(actor, teamRef, "edit");
    await this.assertDocsWritable(actor);
    if (patch.body !== undefined) {
      const bodyBytes = Buffer.byteLength(patch.body, "utf8");
      if (bodyBytes > DOC_BODY_MAX_BYTES) throw new ServiceError("invalid", `Doc body is ${bodyBytes} bytes; the limit is ${DOC_BODY_MAX_BYTES} (200 KB)`);
    }

    if (actor.kind === "agent" && !patch.forcePublish) {
      const existing = await this.resolveDoc(team.id, ref).catch(() => undefined);
      if (existing) {
        const d = await this.maybeDraftDoc(actor, existing, patch);
        if (d) return { ...existing, ...d };
      }
    }

    return this.db.transaction(async () => {
      const found = await this.resolveDoc(team.id, ref);
      const d = (await this.repo.lockDoc(found.id)) ?? found;
      if (expectedVersion !== undefined && expectedVersion !== d.version) {
        throw new ServiceError("conflict", `Doc "${d.title}" was changed (version ${d.version}, you had ${expectedVersion}). Re-read and retry.`, { current: d });
      }
      const clean: Record<string, unknown> = {};
      if (patch.title !== undefined) clean.title = patch.title.trim();
      if (patch.body !== undefined) clean.body = patch.body;
      if (patch.anchors !== undefined) clean.anchors = patch.anchors;
      if (patch.labels !== undefined) clean.labels = cleanDocLabels(patch.labels);
      const changes = diff(d as unknown as Record<string, unknown>, clean);
      // Editing title/body/anchors, or an explicit confirm (mark_doc_fresh-equivalent), clears staleness —
      // same rule as upsertNode's EXPLAINER_FIELDS/anchors/markFresh check.
      const described = "title" in changes || "body" in changes || "anchors" in changes || patch.markFresh || patch.describedSha;
      const fresh = described
        ? {
            stale: false,
            staleReason: null,
            staleSource: null,
            driftPaths: [],
            describedHashes: patch.describedHashes ?? (await this.graph.landedHashesFor(team.id, patch.anchors ?? d.anchors)),
            describedAt: new Date(),
            describedSha: patch.describedSha ?? d.describedSha,
          }
        : {};
      if (!Object.keys(changes).length && !described) return d;
      const updated = await this.repo.updateDoc(d.id, { ...clean, ...fresh, version: d.version + 1, updatedAt: new Date(), updatedByKind: actor.kind, updatedById: actor.id });
      const meaningful = Object.keys(changes);
      if (meaningful.length || (d.stale && described)) {
        await this.events.emit(actor, team.id, {
          type: "doc.updated",
          entity: "doc",
          entityId: updated.id,
          summary: `updated doc "${updated.title}"${meaningful.length ? `: ${meaningful.join(", ")}` : ""}${d.stale && described ? " (now fresh)" : ""}`,
          data: { slug: updated.slug, changes: meaningful },
        });
      }
      return updated;
    });
  }

  /** Clear a doc's stale flag after confirming it's still accurate (no edits needed) — mirrors markFresh for nodes. */
  markDocFresh(actor: Actor, teamRef: string, ref: string, sha?: string) {
    return this.updateDoc(actor, teamRef, ref, { markFresh: true, describedSha: sha });
  }

  /** Move a doc to a new parent and/or position among its siblings. */
  async moveDoc(actor: Actor, teamRef: string, ref: string, opts: { parent?: string | null; index?: number }, expectedVersion?: number): Promise<DocRow> {
    const team = await this.access.require(actor, teamRef, "edit");
    await this.assertDocsWritable(actor);
    return this.db.transaction(async () => {
      const found = await this.resolveDoc(team.id, ref);
      const d = (await this.repo.lockDoc(found.id)) ?? found;
      if (expectedVersion !== undefined && expectedVersion !== d.version) {
        throw new ServiceError("conflict", `Doc "${d.title}" was changed since you read it`, { current: d });
      }
      const parentId = opts.parent === undefined ? d.parentId : opts.parent === null ? null : (await this.resolveDoc(team.id, opts.parent)).id;
      if (parentId === d.id) throw new ServiceError("invalid", "A doc cannot be its own parent");
      // Prevent cycles: the new parent can't be one of this doc's own descendants.
      if (parentId) {
        let cur: string | null = parentId;
        while (cur) {
          if (cur === d.id) throw new ServiceError("invalid", "Can't move a doc under one of its own descendants");
          cur = (await this.repo.parentOf(cur))?.parentId ?? null;
        }
      }
      if (parentId !== d.parentId) {
        const depth = await this.depthOf(team.id, parentId);
        if (depth + 1 > DOC_MAX_DEPTH) throw new ServiceError("invalid", `Docs can nest at most ${DOC_MAX_DEPTH} levels deep`);
      }
      const slug = parentId !== d.parentId ? await this.uniqueSlug(team.id, parentId, d.slug, d.id) : d.slug;
      const siblings = await this.repo.siblingPositions(team.id, parentId, d.id);
      const i = opts.index === undefined || opts.index < 0 || opts.index > siblings.length ? siblings.length : opts.index;
      const before = siblings[i - 1]?.position;
      const after = siblings[i]?.position;
      const position = before === undefined && after === undefined ? 1000 : before === undefined ? after! - 1000 : after === undefined ? before + 1000 : (before + after) / 2;
      const updated = await this.repo.updateDoc(d.id, { parentId, slug, position, version: d.version + 1, updatedAt: new Date(), updatedByKind: actor.kind, updatedById: actor.id });
      await this.events.emit(actor, team.id, {
        type: "doc.moved",
        entity: "doc",
        entityId: updated.id,
        summary: `moved doc "${updated.title}"`,
        data: { slug: updated.slug },
      });
      return updated;
    });
  }

  /** Soft delete: sets deletedAt (kept 30 days for recovery/purge); history lives in `events`. */
  async deleteDoc(actor: Actor, teamRef: string, ref: string) {
    const team = await this.access.require(actor, teamRef, "edit");
    await this.assertDocsWritable(actor);
    return this.db.transaction(async () => {
      const d = await this.resolveDoc(team.id, ref);
      await this.repo.softDeleteDocs([d.id]);
      // Soft-delete descendants too, so a deleted branch doesn't linger half-visible.
      const toDelete = [d.id];
      for (let i = 0; i < toDelete.length; i++) toDelete.push(...(await this.repo.liveChildIds(toDelete[i])));
      if (toDelete.length > 1) await this.repo.softDeleteDocs(toDelete.slice(1));
      await this.events.emit(actor, team.id, {
        type: "doc.deleted",
        entity: "doc",
        entityId: d.id,
        summary: `deleted doc "${d.title}"${toDelete.length > 1 ? ` (and ${toDelete.length - 1} nested)` : ""}`,
        data: { slug: d.slug, title: d.title },
      });
      return { ok: true };
    });
  }

  async linkDocNode(actor: Actor, teamRef: string, docRef: string, nodeRef: string, unlink = false) {
    const team = await this.access.require(actor, teamRef, "edit");
    await this.assertDocsWritable(actor);
    const d = await this.resolveDoc(team.id, docRef);
    const n = await this.graph.resolveNode(team.id, nodeRef);
    if (unlink) await this.repo.unlinkNode(d.id, n.id);
    else await this.repo.linkNode(d.id, n.id);
    return { ok: true };
  }

  // ───────── doc drafts (WH-64) ─────────
  // Mirrors the map's node draft flow exactly: an agent session editing a doc whose anchored files are in flux (changed in that
  // session, not yet landed) gets the edit stored as a draft, published when the map reports those files landed (DocFreshnessService).

  /** If this agent has an active session changing the doc's anchored files, return it. */
  private async fluxSessionForDoc(actor: Actor, doc: DocRow) {
    if (actor.kind !== "agent" || !doc.anchors.length) return null;
    const sessions = await this.sessions.sessionsForTeam(doc.teamId, actor.id);
    return sessions.find((s) => anchoredBy(doc, Object.keys(s.files)).length) ?? null;
  }

  /**
   * Called by updateDoc for agent edits to existing docs. When the agent's own session has the doc's anchored code in flux, the update
   * is stored as a draft and published when that code lands, so the shared doc never describes code that hasn't merged.
   */
  private async maybeDraftDoc(actor: Actor, doc: DocRow, input: DocUpdateInput) {
    const patch: Record<string, unknown> = {};
    for (const k of DOC_PATCH_KEYS) if (input[k] !== undefined) patch[k] = input[k];
    const confirm = !!input.markFresh && !Object.keys(patch).length;
    if (!Object.keys(patch).length && !confirm) return null;
    const session = await this.fluxSessionForDoc(actor, doc);
    if (!session) return null;
    const d = await this.repo.pendingDocDraft(doc.id, session.id);
    if (d) {
      await this.repo.updateDocDraft(d.id, { patch: { ...d.patch, ...patch }, confirm: d.confirm && confirm, updatedAt: new Date() });
    } else {
      await this.repo.insertDocDraft({
        teamId: doc.teamId,
        workspaceId: doc.workspaceId,
        docId: doc.id,
        sessionId: session.id,
        authorName: actor.name,
        authorKind: actor.kind,
        patch,
        confirm,
      });
    }
    await this.events.emit(actor, doc.teamId, {
      type: "doc.drafted",
      entity: "doc",
      entityId: doc.id,
      summary: `drafted ${confirm ? "a confirmation of" : "an update to"} doc "${doc.title}" (publishes when the code lands)`,
      data: { title: doc.title, slug: doc.slug, fields: Object.keys(patch) },
    });
    return {
      draft: true,
      note: "Saved as a draft: this session's changes to the doc's anchored files haven't landed on the default branch yet. It publishes automatically when they do.",
    };
  }

  // ───────── the web app's functions: input shaping, then the same calls ─────────

  async createDocAs(actor: Actor, teamKey: string, b: Body): Promise<DocRow> {
    const title = text(b, "title", { required: true, max: 300, trim: true })!;
    const input: DocInput & { title: string } = {
      title,
      body: text(b, "body"),
      parent: textOrNull(b, "parent"),
      template: oneOf(b, "template", DOC_TEMPLATE_IDS),
    };
    return this.createDoc(actor, teamKey, input);
  }

  /** `version` is the lock: a change made since is a 409 and nothing is overwritten. */
  async updateDocAs(actor: Actor, teamKey: string, ref: string, b: Body): Promise<DocRow> {
    const anchors = textList(b, "anchors");
    const patch = {
      title: text(b, "title", { max: 300 }),
      body: text(b, "body"),
      anchors: anchors?.map((a) => a.trim()).filter(Boolean),
      labels: textList(b, "labels"),
    };
    if (patch.title !== undefined && !patch.title.trim()) bad("title", "title is required");
    return this.updateDoc(actor, teamKey, ref, patch, whole(b, "version"));
  }

  async moveDocAs(actor: Actor, teamKey: string, ref: string, b: Body): Promise<DocRow> {
    const opts = { parent: textOrNull(b, "parent"), index: whole(b, "index") };
    return this.moveDoc(actor, teamKey, ref, opts, whole(b, "version"));
  }
}
