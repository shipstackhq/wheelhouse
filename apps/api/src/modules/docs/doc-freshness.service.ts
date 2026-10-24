import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { schema } from "../../db";
import { anchorScore, anchoredBy, type ChangesReported, type ChangesReportedResult, type FilesLanded, type FilesLandedResult, type SessionSynced } from "../map/index";
import { TeamAccessService } from "../teams/index";
import { DocsRepository, type DocDraftRow } from "./docs.repository";
import { DocsService, type DocUpdateInput } from "./docs.service";

/** "a.ts, b.ts +2 more changed in abc12345" (the reason a doc is flagged), as the map words it for its nodes. */
const changedReason = (paths: string[], short: string | undefined) => `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` +${paths.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}`;

/**
 * What keeps the docs honest, the same rules the map applies to its nodes (WH-64). A doc anchored to a changed file is flagged stale;
 * when files land on the default branch the doc records their hashes, publishes the drafts agents wrote against that code, or flags
 * drift. The map tells the docs module through events (map.events.ts); `DocsListeners` calls the methods below, which run inside the
 * map's transaction. A person can also publish or discard a pending draft now. Every method that takes a team ref resolves it through
 * TeamAccessService.
 */
@Injectable()
export class DocFreshnessService {
  constructor(
    @Inject(DocsRepository) private readonly repo: DocsRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(DocsService) private readonly docs: DocsService,
  ) {}

  /** Docs flagged stale (their anchored code changed since last confirmed), with reason and anchors to re-read. */
  async listStaleDocs(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    return this.repo.staleDocsOf(team.id);
  }

  async listDocDrafts(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    return this.repo.pendingDocDraftsOf(team.id);
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
    await this.docs.updateDoc(actor, teamId, d.docId, { ...(d.patch as DocUpdateInput), markFresh: true, forcePublish: true, describedHashes: hashes });
  }

  // ───────── what the map reports ─────────

  /** Files were reported changed: flag the docs anchored to them. No per-layer grouping (docs aren't layered): any anchor match flags the doc. */
  async changesReported({ teamId, files, sha, summary, repository }: ChangesReported): Promise<ChangesReportedResult> {
    const short = sha ? sha.slice(0, 8) : undefined;
    const allDocs = await this.repo.liveDocRows(teamId);
    const hits = new Map<string, { doc: (typeof allDocs)[number]; files: string[] }>();
    for (const f of files) {
      for (const d of allDocs) {
        if (!d.anchors.length) continue;
        if (Math.max(0, ...d.anchors.map((a) => anchorScore(a, f, repository))) <= 0) continue;
        const h = hits.get(d.id) ?? { doc: d, files: [] };
        h.files.push(f);
        hits.set(d.id, h);
      }
    }
    // Changes at the commit a doc was described at aren't news.
    for (const [id, { doc: d }] of hits) {
      if (sha && d.describedSha && (sha.startsWith(d.describedSha) || d.describedSha.startsWith(sha))) hits.delete(id);
    }
    for (const { doc: d, files: fs } of hits.values()) {
      const reason = `${changedReason(fs, short)}${summary ? `: ${summary}` : ""}`;
      await this.repo.updateDocFreshness(d.id, { stale: true, staleSource: "report", staleReason: reason.slice(0, 500) });
    }
    const anchored = new Set<string>();
    for (const d of allDocs) for (const f of files) if (d.anchors.some((a) => anchorScore(a, f, repository))) anchored.add(f);
    return { marked: [...hits.values()].map(({ doc: d, files: fs }) => ({ id: d.id, title: d.title, slug: d.slug, files: fs })), anchored: [...anchored] };
  }

  /**
   * Code landed on the default branch: each doc anchored to a changed path publishes the drafts written against that code, or records
   * the hashes (a baseline, or a doc never baselined) or flags drift. Reverting a file to its described content clears its drift.
   */
  async filesLanded({ actor, teamId, files: changed, baseline, sha, repository }: FilesLanded): Promise<FilesLandedResult> {
    const ds = await this.repo.liveDocRows(teamId);
    const affected = new Map<string, { doc: (typeof ds)[number]; files: [string, string | null][] }>();
    for (const [path, hash] of changed) {
      for (const d of ds.filter((x) => anchoredBy(x, [path], repository).length)) {
        const a = affected.get(d.id) ?? { doc: d, files: [] };
        a.files.push([path, hash]);
        affected.set(d.id, a);
      }
    }
    const pending = affected.size ? await this.repo.pendingDocDraftsFor([...affected.keys()]) : [];
    const published: string[] = [];
    const stale: string[] = [];
    const fresh: string[] = [];
    const short = sha?.slice(0, 8);

    for (const { doc, files } of affected.values()) {
      const landedHashes: Record<string, string> = { ...doc.describedHashes };
      for (const [p, h] of files) {
        if (h) landedHashes[p] = h;
        else delete landedHashes[p];
      }
      const drafts = pending.filter((d) => d.docId === doc.id);
      if (drafts.length && !baseline) {
        // The work that was in flux has landed: publish what the agent wrote against it.
        for (const d of drafts) {
          await this.applyDocDraft(actor, teamId, d, landedHashes);
          await this.repo.updateDocDraft(d.id, { status: "published", updatedAt: new Date() });
        }
        published.push(doc.slug);
        continue;
      }

      const neverBaselined = !Object.keys(doc.describedHashes).length;
      const drift = new Set(doc.driftPaths);
      const described = { ...doc.describedHashes };
      for (const [p, h] of files) {
        if (baseline || neverBaselined) {
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
        Object.assign(set, { stale: true, staleSource: "drift", staleReason: `${changedReason(driftPaths, short)} since it was described` });
        if (!doc.stale) stale.push(doc.slug);
      } else if (!nowStale && wasDrift) {
        Object.assign(set, { stale: false, staleSource: null, staleReason: null });
        fresh.push(doc.slug);
      }
      await this.repo.updateDocFreshness(doc.id, set);
    }
    return { published, stale, fresh };
  }

  /** Doc drafts whose code this session no longer has in flux were abandoned (e.g. reverted). */
  async sessionSynced({ teamId, sessionId, touched, repository }: SessionSynced) {
    const drafts = await this.repo.pendingDocDraftsOfSession(sessionId);
    if (!drafts.length) return;
    const ds = await this.repo.liveDocRows(teamId);
    for (const d of drafts) {
      const doc = ds.find((x) => x.id === d.docId);
      if (!doc || !anchoredBy(doc, touched, repository).length) await this.repo.updateDocDraft(d.id, { status: "discarded", updatedAt: new Date() });
    }
  }
}
