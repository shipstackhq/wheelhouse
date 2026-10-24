import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { emit } from "../../platform/events/emit";
import { DocRow } from "../docs/docs";
import { Layer, NodeRow, upsertNode } from "./graph";
import { findOrCreateRepository } from "../github/repositories";
import { requireTeam } from "../teams/teams";

const { nodes, docs } = schema;

// ───────── freshness ─────────

export const normPath = (p: string) => p.trim().replace(/^\.\//, "").replace(/\\/g, "/");

/**
 * An anchor may carry an optional repo qualifier, "backend:src/**": only files
 * reported under that repo's slug/role match. A bare anchor ("src/db/**") has
 * no qualifier and matches files from any repository (the backward-compat
 * default — existing single-repo teams keep working with no action).
 *
 * Heuristic: a qualifier is a prefix before the first colon, itself containing
 * no "/" and no glob characters — real anchors are repo-relative paths/globs
 * ("src/db/**", "drizzle/**") which never start that way, so this never
 * misparses an existing anchor.
 */
export function parseAnchor(anchor: string): { repo: string | null; pattern: string } {
  const i = anchor.indexOf(":");
  if (i > 0) {
    const prefix = anchor.slice(0, i);
    if (!/[/*?]/.test(prefix)) return { repo: prefix.toLowerCase(), pattern: anchor.slice(i + 1) };
  }
  return { repo: null, pattern: anchor };
}

/**
 * How specifically `anchor` matches `file` (0 = no match). Longer literal
 * prefix = more specific. `fileRepo` is the repo slug/role the file was
 * reported under (from team_files.repositoryId / the session's file
 * tracking); an anchor qualified to a different repo never matches it, and an
 * unqualified anchor matches regardless of `fileRepo` (including when it's
 * unknown/null).
 */
export function anchorScore(anchor: string, file: string, fileRepo?: string | null) {
  const { repo, pattern } = parseAnchor(anchor);
  if (repo && (!fileRepo || fileRepo.toLowerCase() !== repo)) return 0;
  const a = normPath(pattern).split("#")[0];
  const f = normPath(file);
  if (!a) return 0;
  if (/[*?]/.test(a)) {
    const re = new RegExp(
      "^" +
        a
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\/?/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/\u0000/g, ".*") +
        "$",
    );
    return re.test(f) ? a.replace(/[*?].*$/, "").length + 1 : 0;
  }
  if (f === a) return a.length + 1000; // exact file beats any directory/glob
  const dir = a.endsWith("/") ? a : a + "/";
  return f.startsWith(dir) ? dir.length : 0;
}

/**
 * Report files changed by a commit/PR/agent session. For each file, the most
 * specifically-anchored nodes are marked stale (so a tweak to service.ts flags
 * the "service layer" node, not every node anchored at src/**).
 */
export async function reportChanges(
  actor: Actor,
  teamRef: string,
  input: { files: string[]; sha?: string; summary?: string; repository?: string },
) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const files = [...new Set(input.files.map(normPath).filter(Boolean))];
  if (!files.length) throw new ServiceError("invalid", "files is empty");
  // Which repo these files belong to, for repo-qualified anchor matching ("backend:src/**").
  // Omitted (old CLI / repos without wheelhouse.json repo info) falls back to the team's
  // unqualified default repo, so unqualified anchors (the common case) keep matching regardless.
  const repo = await findOrCreateRepository(actor, team.id, input.repository);
  const ns = await db.select().from(nodes).where(eq(nodes.teamId, team.id));
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
  const allDocs = await db.select().from(docs).where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt)));
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

  return db.transaction(async (tx) => {
    for (const { node, files: fs } of hits.values()) {
      const reason = `${fs.slice(0, 3).join(", ")}${fs.length > 3 ? ` +${fs.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}${input.summary ? `: ${input.summary}` : ""}`;
      await tx.update(nodes).set({ stale: true, staleSource: "report", staleReason: reason.slice(0, 500) }).where(eq(nodes.id, node.id));
    }
    for (const { doc: d, files: fs } of docHits.values()) {
      const reason = `${fs.slice(0, 3).join(", ")}${fs.length > 3 ? ` +${fs.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}${input.summary ? `: ${input.summary}` : ""}`;
      await tx.update(docs).set({ stale: true, staleSource: "report", staleReason: reason.slice(0, 500) }).where(eq(docs.id, d.id));
    }
    const marked = [...hits.values()].map(({ node, files: fs }) => ({ name: node.name, layer: node.layer, files: fs }));
    const docsMarked = [...docHits.values()].map(({ doc: d, files: fs }) => ({ id: d.id, title: d.title, slug: d.slug, files: fs }));
    await emit(tx, actor, team.id, {
      type: "code.changed",
      entity: "team",
      entityId: team.id,
      summary: `reported ${files.length} changed file(s)${short ? ` (${short})` : ""}; ${marked.length} map node(s)${docsMarked.length ? ` and ${docsMarked.length} doc(s)` : ""} need re-describing`,
      data: { sha: input.sha, files: files.slice(0, 50), stale: marked.map((m) => `${m.layer}:${m.name}`), staleDocs: docsMarked.map((m) => m.slug) },
    });
    if (repo) await tx.update(schema.repositories).set({ lastEventAt: new Date() }).where(eq(schema.repositories.id, repo.id));
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

export async function listStale(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const rows = await db
    .select({ id: nodes.id, name: nodes.name, layer: nodes.layer, kind: nodes.kind, reason: nodes.staleReason, anchors: nodes.anchors })
    .from(nodes)
    .where(and(eq(nodes.teamId, team.id), eq(nodes.stale, true)));
  return rows;
}

export async function markFresh(actor: Actor, teamRef: string, ref: string, sha?: string) {
  return upsertNode(actor, teamRef, { id: ref, markFresh: true, describedSha: sha });
}

/** Docs flagged stale (their anchored code changed since last confirmed), with reason and anchors to re-read. */
export async function listStaleDocs(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db
    .select({ id: docs.id, slug: docs.slug, title: docs.title, reason: docs.staleReason, anchors: docs.anchors })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), eq(docs.stale, true), isNull(docs.deletedAt)));
}
