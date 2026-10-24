import { Inject, Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";
import { EventsService } from "../../platform/events/events.service";
import { RepositoriesService } from "../github/index";
import { TeamAccessService } from "../teams/index";
import { ACTIVE_SESSION_MS, anchorScore, anchoredBy, bestMatches, normPath, type Layer, type NodeInput } from "./map.rules";
import { CHANGES_REPORTED, FILES_LANDED, type ChangesReported, type ChangesReportedResult, type FilesLanded, type FilesLandedResult } from "./map.events";
import { MapRepository, type NodeDraftRow, type NodeRow } from "./map.repository";
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
 * Freshness: what keeps the map's explanations honest. Reported changes mark the most specifically anchored nodes stale; landing (a push
 * to the default branch) records the files' hashes, publishes the drafts agents wrote against that code and flags drift where no draft
 * exists. The docs follow the same rules in the docs module, which hears about reports and landings through events (map.events.ts).
 * Every method resolves the team through TeamAccessService.
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
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
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

    return this.db.transaction(async () => {
      for (const { node, files: fs } of hits.values()) {
        const reason = `${fs.slice(0, 3).join(", ")}${fs.length > 3 ? ` +${fs.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}${input.summary ? `: ${input.summary}` : ""}`;
        await this.repo.updateNode(node.id, { stale: true, staleSource: "report", staleReason: reason.slice(0, 500) });
      }
      // Same pipeline for docs (WH-64): the docs module flags the docs anchored to a changed file, parallel to nodes.
      const [docs] = (await this.emitter.emitAsync(CHANGES_REPORTED, { actor, teamId: team.id, files, sha: input.sha, summary: input.summary, repository: repo?.slug } satisfies ChangesReported)) as (ChangesReportedResult | undefined)[];
      const marked = [...hits.values()].map(({ node, files: fs }) => ({ name: node.name, layer: node.layer, files: fs }));
      const docsMarked = docs?.marked ?? [];
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
      for (const f of docs?.anchored ?? []) anchoredFiles.add(f);
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

    const pending = affected.size ? await this.repo.pendingNodeDraftsFor([...affected.keys()]) : [];

    const published: string[] = [];
    const stale: string[] = [];
    const fresh: string[] = [];
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

    // Same for docs (WH-64): the docs module records, publishes or flags the docs anchored to the changed paths.
    const [docs] = (await this.emitter.emitAsync(FILES_LANDED, { actor, teamId: team.id, files: changed, baseline: !!r.baseline, sha: r.sha, repository: repo?.slug } satisfies FilesLanded)) as (FilesLandedResult | undefined)[];
    const publishedDocs = docs?.published ?? [];
    const staleDocs = docs?.stale ?? [];
    const freshDocs = docs?.fresh ?? [];

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
