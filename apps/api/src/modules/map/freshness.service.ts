import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";
import { EventsService } from "../../platform/events/events.service";
import { updateDoc, type DocRow, type DocUpdateInput } from "../docs/index";
import { RepositoriesService } from "../github/index";
import { TeamAccessService } from "../teams/index";
import { ACTIVE_SESSION_MS, anchorScore, anchoredBy, bestMatches, normPath, type Layer, type NodeInput } from "./map.rules";
import { MapRepository, type DocDraftRow, type NodeDraftRow, type NodeRow } from "./map.repository";
import { GraphService } from "./graph.service";

export type LandReport = {
  sha?: string;
  branch?: string;
  /** Changed paths on the default branch → new content hash (null = deleted). */
  files: Record<string, string | null>;
  /** Initial import: record hashes as the described baseline without flagging anything. */
  baseline?: boolean;
  /** wheelhouse.json's repository name/slug (WH-68). Omitted = old client / no repo info: falls back to the team's unqualified default repo, so single-repo teams keep working unchanged. */
  repository?: string;
};

/**
 * Freshness: what keeps the map's (and the docs') explanations honest. Reported changes mark the most specifically anchored nodes and
 * docs stale; landing (a push to the default branch) records the files' hashes, publishes the drafts agents wrote against that code and
 * flags drift where no draft exists. Every method resolves the team through TeamAccessService.
 */
@Injectable()
export class FreshnessService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MapRepository) private readonly repo: MapRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
    @Inject(GraphService) private readonly graph: GraphService,
  ) {}

  // ───────── reported changes ─────────

  /**
   * Report files changed by a commit/PR/agent session. For each file, the most specifically-anchored nodes are marked stale (so a tweak
   * to service.ts flags the "service layer" node, not every node anchored at src/**).
   */
  async reportChanges(actor: Actor, teamRef: string, input: { files: string[]; sha?: string; summary?: string; repository?: string }) {
    const team = await this.access.require(actor, teamRef, "edit");
    const files = [...new Set(input.files.map(normPath).filter(Boolean))];
    if (!files.length) throw new ServiceError("invalid", "files is empty");
    // Which repo these files belong to, for repo-qualified anchor matching ("backend:src/**").
    // Omitted (old CLI / repos without wheelhouse.json repo info) falls back to the team's
    // unqualified default repo, so unqualified anchors (the common case) keep matching regardless.
    const repo = await this.repositories.findOrCreateRepository(actor, team.id, input.repository);
    const ns = await this.repo.nodesOf(team.id);
    const hits = new Map<string, { node: NodeRow; files: string[] }>();
    for (const f of files) {
      // Most specific match per layer: a change to service.ts flags the
      // "service.ts" code node and the "Service layer" system node, not every
      // node anchored at src/**.
      const best: Partial<Record<Layer, { score: number; nodes: NodeRow[] }>> = {};
      for (const n of ns) {
        const s = Math.max(0, ...n.anchors.map((a) => anchorScore(a, f, repo?.slug)));
        if (!s) continue;
        const b = best[n.layer];
        if (!b || s > b.score) best[n.layer] = { score: s, nodes: [n] };
        else if (s === b.score) b.nodes.push(n);
      }
      for (const n of Object.values(best).flatMap((b) => b!.nodes)) {
        const h = hits.get(n.id) ?? { node: n, files: [] };
        h.files.push(f);
        hits.set(n.id, h);
      }
    }
    const short = input.sha ? input.sha.slice(0, 8) : null;
    // Changes at the commit a node was described at aren't news.
    for (const [id, { node }] of hits) {
      if (input.sha && node.describedSha && (input.sha.startsWith(node.describedSha) || node.describedSha.startsWith(input.sha))) hits.delete(id);
    }

    // Same pipeline for docs (WH-64): a doc anchored to a changed file is flagged, parallel to nodes.
    // No per-layer "most specific" grouping here (docs aren't layered) — any anchor match flags the doc.
    const allDocs = await this.repo.liveDocsOf(team.id);
    const docHits = new Map<string, { doc: DocRow; files: string[] }>();
    for (const f of files) {
      for (const d of allDocs) {
        if (!d.anchors.length) continue;
        if (Math.max(0, ...d.anchors.map((a) => anchorScore(a, f, repo?.slug))) <= 0) continue;
        const h = docHits.get(d.id) ?? { doc: d, files: [] };
        h.files.push(f);
        docHits.set(d.id, h);
      }
    }
    for (const [id, { doc: d }] of docHits) {
      if (input.sha && d.describedSha && (input.sha.startsWith(d.describedSha) || d.describedSha.startsWith(input.sha))) docHits.delete(id);
    }

    return this.db.transaction(async () => {
      for (const { node, files: fs } of hits.values()) {
        const reason = `${fs.slice(0, 3).join(", ")}${fs.length > 3 ? ` +${fs.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}${input.summary ? `: ${input.summary}` : ""}`;
        await this.repo.updateNode(node.id, { stale: true, staleSource: "report", staleReason: reason.slice(0, 500) });
      }
      for (const { doc: d, files: fs } of docHits.values()) {
        const reason = `${fs.slice(0, 3).join(", ")}${fs.length > 3 ? ` +${fs.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}${input.summary ? `: ${input.summary}` : ""}`;
        await this.repo.updateDocFreshness(d.id, { stale: true, staleSource: "report", staleReason: reason.slice(0, 500) });
      }
      const marked = [...hits.values()].map(({ node, files: fs }) => ({ name: node.name, layer: node.layer, files: fs }));
      const docsMarked = [...docHits.values()].map(({ doc: d, files: fs }) => ({ id: d.id, title: d.title, slug: d.slug, files: fs }));
      await this.events.emit(actor, team.id, {
        type: "code.changed",
        entity: "team",
        entityId: team.id,
        summary: `reported ${files.length} changed file(s)${short ? ` (${short})` : ""}; ${marked.length} map node(s)${docsMarked.length ? ` and ${docsMarked.length} doc(s)` : ""} need re-describing`,
        data: { sha: input.sha, files: files.slice(0, 50), stale: marked.map((m) => `${m.layer}:${m.name}`), staleDocs: docsMarked.map((m) => m.slug) },
      });
      if (repo) await this.repo.touchRepository(repo.id);
      const anchoredFiles = new Set<string>();
      for (const n of ns) for (const f of files) if (n.anchors.some((a) => anchorScore(a, f, repo?.slug))) anchoredFiles.add(f);
      for (const d of allDocs) for (const f of files) if (d.anchors.some((a) => anchorScore(a, f, repo?.slug))) anchoredFiles.add(f);
      return {
        files: files.length,
        staleMarked: marked,
        staleDocsMarked: docsMarked,
        unanchored: files.filter((f) => !anchoredFiles.has(f)),
      };
    });
  }

  async listStale(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    return this.repo.staleNodes(team.id);
  }

  markFresh(actor: Actor, teamRef: string, ref: string, sha?: string) {
    return this.graph.upsertNode(actor, teamRef, { id: ref, markFresh: true, describedSha: sha });
  }

  /** Docs flagged stale (their anchored code changed since last confirmed), with reason and anchors to re-read. */
  async listStaleDocs(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    return this.repo.staleDocsOf(team.id);
  }

  // ───────── drafts ─────────

  /** Human action: publish or discard a pending draft now. */
  async resolveDraft(actor: Actor, teamRef: string, draftId: string, action: "publish" | "discard") {
    const team = await this.access.require(actor, teamRef, "edit");
    const d = await this.repo.findPendingNodeDraft(team.id, draftId);
    if (!d) throw new ServiceError("not_found", "Draft not found or already resolved");
    if (action === "publish") await this.applyDraft(actor, team.id, d);
    await this.repo.updateNodeDraft(d.id, { status: action === "publish" ? "published" : "discarded", updatedAt: new Date() });
    return { ok: true };
  }

  private async applyDraft(actor: Actor, teamId: string, d: NodeDraftRow, hashes?: Record<string, string>) {
    await this.graph.upsertNode(actor, teamId, { id: d.nodeId, ...(d.patch as NodeInput), markFresh: true, forcePublish: true, describedHashes: hashes });
  }

  /** Human action: publish or discard a pending doc draft now. */
  async resolveDocDraft(actor: Actor, teamRef: string, draftId: string, action: "publish" | "discard") {
    const team = await this.access.require(actor, teamRef, "edit");
    const d = await this.repo.findPendingDocDraft(team.id, draftId);
    if (!d) throw new ServiceError("not_found", "Draft not found or already resolved");
    if (action === "publish") await this.applyDocDraft(actor, team.id, d);
    await this.repo.updateDocDraft(d.id, { status: action === "publish" ? "published" : "discarded", updatedAt: new Date() });
    return { ok: true };
  }

  private async applyDocDraft(actor: Actor, teamId: string, d: DocDraftRow, hashes?: Record<string, string>) {
    await updateDoc(actor, teamId, d.docId, { ...(d.patch as DocUpdateInput), markFresh: true, forcePublish: true, describedHashes: hashes });
  }

  // ───────── landing ─────────

  /**
   * Code landed on the default branch (git hook / CI, or a push GitHub reported). Updates the server's view of the branch, publishes
   * drafts for the affected nodes, and flags drift where no draft exists. Reverting a file to its described content clears its drift.
   *
   * Repository qualification (WH-68): a monorepo connected to several teams reports changes to all of them, but each team's
   * `repositories` row carries its own `pathLimit` (a directory such as "packages/billing/"); files outside this team's path limit are
   * ignored here so each team only sees the slice of the monorepo it owns.
   */
  async land(actor: Actor, teamRef: string, r: LandReport) {
    const team = await this.access.require(actor, teamRef, "edit");
    const repo = await this.repositories.findOrCreateRepository(actor, team.id, r.repository);
    const limit = repo?.pathLimit?.trim().replace(/^\/+/, "").replace(/\/*$/, "/") || null;
    const changed = Object.entries(r.files ?? {})
      .map(([p, h]) => [normPath(p), h] as const)
      .filter(([p]) => p && (!limit || p.startsWith(limit)));
    if (!changed.length) return { files: 0, published: [], stale: [], fresh: [], publishedDocs: [], staleDocs: [], freshDocs: [] };

    for (const [path, hash] of changed) {
      if (hash) await this.repo.upsertLandedFile({ teamId: team.id, workspaceId: team.workspaceId, path, hash, sha: r.sha ?? null, repositoryId: repo?.id ?? null });
      else await this.repo.deleteLandedFile(team.id, path);
    }

    const ns = await this.repo.nodesOf(team.id);
    const affected = new Map<string, { node: NodeRow; files: [string, string | null][] }>();
    for (const [path, hash] of changed) {
      for (const n of r.baseline ? ns.filter((x) => anchoredBy(x, [path], repo?.slug).length) : bestMatches(ns, path, repo?.slug)) {
        const a = affected.get(n.id) ?? { node: n, files: [] };
        a.files.push([path, hash]);
        affected.set(n.id, a);
      }
    }

    // Same for docs (WH-64): no per-layer grouping, so any doc anchored to a changed path is affected.
    const ds = await this.repo.liveDocsOf(team.id);
    const affectedDocs = new Map<string, { doc: DocRow; files: [string, string | null][] }>();
    for (const [path, hash] of changed) {
      for (const d of ds.filter((x) => anchoredBy(x, [path], repo?.slug).length)) {
        const a = affectedDocs.get(d.id) ?? { doc: d, files: [] };
        a.files.push([path, hash]);
        affectedDocs.set(d.id, a);
      }
    }

    const pending = affected.size ? await this.repo.pendingNodeDraftsFor([...affected.keys()]) : [];
    const pendingDocs = affectedDocs.size ? await this.repo.pendingDocDraftsFor([...affectedDocs.keys()]) : [];

    const published: string[] = [];
    const stale: string[] = [];
    const fresh: string[] = [];
    const publishedDocs: string[] = [];
    const staleDocs: string[] = [];
    const freshDocs: string[] = [];
    const short = r.sha?.slice(0, 8);

    for (const { node, files } of affected.values()) {
      const landedHashes: Record<string, string> = { ...node.describedHashes };
      for (const [p, h] of files) {
        if (h) landedHashes[p] = h;
        else delete landedHashes[p];
      }
      const drafts = pending.filter((d) => d.nodeId === node.id);
      if (drafts.length && !r.baseline) {
        // The work that was in flux has landed: publish what the agent wrote against it.
        for (const d of drafts) {
          await this.applyDraft(actor, team.id, d, landedHashes);
          await this.repo.updateNodeDraft(d.id, { status: "published", updatedAt: new Date() });
        }
        published.push(`${node.layer}:${node.name}`);
        continue;
      }

      const neverBaselined = !Object.keys(node.describedHashes).length;
      const drift = new Set(node.driftPaths);
      const described = { ...node.describedHashes };
      for (const [p, h] of files) {
        if (r.baseline || neverBaselined) {
          if (h) described[p] = h;
          continue;
        }
        if (!h) {
          if (p in described) drift.add(p); // a described file was deleted
          continue;
        }
        if (described[p] === h) drift.delete(p);
        else drift.add(p);
      }
      const driftPaths = [...drift];
      const wasDrift = node.stale && node.staleSource === "drift";
      const nowStale = driftPaths.length > 0;
      const set: Partial<typeof schema.nodes.$inferInsert> = { describedHashes: described, driftPaths };
      if (nowStale && !(node.stale && node.staleSource === "report")) {
        Object.assign(set, {
          stale: true,
          staleSource: "drift",
          staleReason: `${driftPaths.slice(0, 3).join(", ")}${driftPaths.length > 3 ? ` +${driftPaths.length - 3} more` : ""} changed${short ? ` in ${short}` : ""} since it was described`,
        });
        if (!node.stale) stale.push(`${node.layer}:${node.name}`);
      } else if (!nowStale && wasDrift) {
        Object.assign(set, { stale: false, staleSource: null, staleReason: null });
        fresh.push(`${node.layer}:${node.name}`);
      }
      await this.repo.updateNode(node.id, set);
    }

    for (const { doc, files } of affectedDocs.values()) {
      const landedHashes: Record<string, string> = { ...doc.describedHashes };
      for (const [p, h] of files) {
        if (h) landedHashes[p] = h;
        else delete landedHashes[p];
      }
      const drafts = pendingDocs.filter((d) => d.docId === doc.id);
      if (drafts.length && !r.baseline) {
        // The work that was in flux has landed: publish what the agent wrote against it.
        for (const d of drafts) {
          await this.applyDocDraft(actor, team.id, d, landedHashes);
          await this.repo.updateDocDraft(d.id, { status: "published", updatedAt: new Date() });
        }
        publishedDocs.push(doc.slug);
        continue;
      }

      const neverBaselined = !Object.keys(doc.describedHashes).length;
      const drift = new Set(doc.driftPaths);
      const described = { ...doc.describedHashes };
      for (const [p, h] of files) {
        if (r.baseline || neverBaselined) {
          if (h) described[p] = h;
          continue;
        }
        if (!h) {
          if (p in described) drift.add(p); // a described file was deleted
          continue;
        }
        if (described[p] === h) drift.delete(p);
        else drift.add(p);
      }
      const driftPaths = [...drift];
      const wasDrift = doc.stale && doc.staleSource === "drift";
      const nowStale = driftPaths.length > 0;
      const set: Partial<typeof schema.docs.$inferInsert> = { describedHashes: described, driftPaths };
      if (nowStale && !(doc.stale && doc.staleSource === "report")) {
        Object.assign(set, {
          stale: true,
          staleSource: "drift",
          staleReason: `${driftPaths.slice(0, 3).join(", ")}${driftPaths.length > 3 ? ` +${driftPaths.length - 3} more` : ""} changed${short ? ` in ${short}` : ""} since it was described`,
        });
        if (!doc.stale) staleDocs.push(doc.slug);
      } else if (!nowStale && wasDrift) {
        Object.assign(set, { stale: false, staleSource: null, staleReason: null });
        freshDocs.push(doc.slug);
      }
      await this.repo.updateDocFreshness(doc.id, set);
    }

    // Sessions whose in-flux files just landed (same content, or unknown) are no longer in flux for them.
    const landedMap = new Map(changed);
    for (const s of await this.repo.activeSessions(team.id, ACTIVE_SESSION_MS)) {
      let dirty = false;
      const files = { ...s.files };
      for (const [p, f] of Object.entries(files)) {
        if (!landedMap.has(p)) continue;
        if (f.hash === null || f.hash === landedMap.get(p)) {
          delete files[p];
          dirty = true;
        }
      }
      if (dirty) await this.repo.updateSession(s.id, { files, firstChangeAt: Object.keys(files).length ? s.firstChangeAt : null });
    }

    if (!r.baseline) {
      await this.events.emit(actor, team.id, {
        type: "code.landed",
        entity: "team",
        entityId: team.id,
        summary: `landed ${changed.length} file(s)${short ? ` (${short})` : ""}${published.length ? `; published ${published.length} map draft(s)` : ""}${stale.length ? `; ${stale.length} node(s) drifted` : ""}${fresh.length ? `; ${fresh.length} back in sync` : ""}${publishedDocs.length ? `; published ${publishedDocs.length} doc draft(s)` : ""}${staleDocs.length ? `; ${staleDocs.length} doc(s) drifted` : ""}${freshDocs.length ? `; ${freshDocs.length} doc(s) back in sync` : ""}`,
        data: { sha: r.sha, branch: r.branch, published, stale, fresh, publishedDocs, staleDocs, freshDocs },
      });
    }
    return { files: changed.length, published, stale, fresh, publishedDocs, staleDocs, freshDocs };
  }
}
