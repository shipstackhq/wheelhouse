import { execFileSync } from "node:child_process";
import { anchorScore, normPath, parseAnchor } from "../lib/service";
import type { Q } from "./db-copy";

/**
 * Re-anchoring the map and the docs after files move (WH-101).
 *
 * Map nodes and docs carry anchors (paths and globs such as `src/lib/service.ts`, `src/db/**`, `src/db/schema.ts#docs`) that say which code
 * they describe, and the content hashes of that code at the time they were described (`described_hashes`). When files move, anchors that
 * name old paths stop matching anything, and a baseline that is not carried over makes the next landing flag the node stale for a file that
 * did not change. This rewrites both, from two things: what git says moved between two refs (renames, with their similarity), and a short
 * reviewed file of rules for what git cannot know (a Next page rewritten as a React page is a new file, not a rename).
 *
 * Nothing is guessed: an anchor is kept, rewritten by a rename or a rule, or reported as unmapped or dangling and left alone.
 */

export type Rules = {
  /** The project whose anchors name this repository's paths. Other projects' anchors (other repositories) are never touched. */
  project: string;
  /** Slugs that mean this repository in a repo-qualified anchor ("wheelhouse:**"); qualified anchors of any other repository are left alone. */
  repository?: string[];
  /** An anchor (without its repo qualifier or #symbol) -> the anchors that replace it. One may become several. */
  anchors: Record<string, string[]>;
};

export type Tree = { oldFiles: string[]; newFiles: string[]; renames: Map<string, string> };

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The files at two refs and what git calls a rename between them (50% similar or more; the similarity is not needed, a moved file keeps its description). */
export function gitTree(repoDir: string, oldRef: string, newRef: string): Tree {
  const list = (ref: string) => git(repoDir, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean).map(normPath);
  const renames = new Map<string, string>();
  // `-z` output is NUL-separated: a status, then one path (two for a rename or a copy).
  const cells = git(repoDir, "diff", "-M50%", "--name-status", "-z", oldRef, newRef).split("\0");
  for (let i = 0; i < cells.length; ) {
    const status = cells[i];
    if (/^R\d*$/.test(status)) {
      renames.set(normPath(cells[i + 1]), normPath(cells[i + 2]));
      i += 3;
    } else if (/^C\d*$/.test(status)) i += 3;
    else i += 2;
  }
  return { oldFiles: list(oldRef), newFiles: list(newRef), renames };
}

export type Action = "keep" | "rewrite" | "outside" | "unmapped" | "dangling";
export type AnchorPlan = { anchor: string; action: Action; to: string[]; note: string };

const isGlob = (p: string) => /[*?]/.test(p);
const matchesAny = (pattern: string, files: string[]) => files.some((f) => anchorScore(pattern, f) > 0);
const literalPrefix = (p: string) => p.replace(/[*?].*$/, "");

/** What to do with one anchor. */
export function planAnchor(anchor: string, tree: Tree, rules: Rules): AnchorPlan {
  const { repo, pattern } = parseAnchor(anchor);
  const ours = (rules.repository ?? []).map((r) => r.toLowerCase());
  if (repo && !ours.includes(repo)) return { anchor, action: "outside", to: [anchor], note: `another repository (${repo})` };
  const [rawBase, symbol] = pattern.split("#");
  const base = normPath(rawBase);
  const qualify = (p: string) => `${repo ? `${anchor.slice(0, anchor.indexOf(":") + 1)}` : ""}${p}${symbol !== undefined ? `#${symbol}` : ""}`;
  const newSet = new Set(tree.newFiles);

  const rule = rules.anchors[base] ?? rules.anchors[pattern];
  let targets: string[] | null = null;
  let note = "";
  if (rule) {
    targets = rule.map(normPath);
    note = "by rule";
  } else if (!isGlob(base) && !base.endsWith("/")) {
    if (tree.renames.has(base)) {
      targets = [tree.renames.get(base)!];
      note = "renamed";
    } else if (newSet.has(base)) return { anchor, action: "keep", to: [anchor], note: "the file is where it was" };
  } else {
    if (!literalPrefix(base) && matchesAny(base, tree.newFiles)) return { anchor, action: "keep", to: [anchor], note: "it names the whole repository" };
    const matchedOld = tree.oldFiles.filter((f) => anchorScore(base, f) > 0);
    if (matchedOld.length && matchedOld.every((f) => newSet.has(f))) return { anchor, action: "keep", to: [anchor], note: "everything it matched is where it was" };
    if (!matchedOld.length && matchesAny(base, tree.newFiles)) return { anchor, action: "keep", to: [anchor], note: "matches files in the new tree" };
    // Moved as a directory: the files that git calls renames all went from the same prefix to the same new prefix.
    const moves = matchedOld.filter((f) => tree.renames.has(f)).map((f) => [f, tree.renames.get(f)!] as const);
    const from = literalPrefix(base);
    const prefixes = new Set(moves.map(([o, n]) => (o.startsWith(from) && n.endsWith(o.slice(from.length)) ? n.slice(0, n.length - (o.length - from.length)) : "")));
    if (moves.length === matchedOld.length && moves.length > 0 && prefixes.size === 1 && !prefixes.has("")) {
      targets = [`${[...prefixes][0]}${base.slice(from.length)}`];
      note = "the directory was renamed";
    }
  }
  if (!targets) return { anchor, action: "unmapped", to: [anchor], note: "no rename and no rule says where it went" };
  const dead = targets.filter((t) => !matchesAny(t, tree.newFiles));
  if (dead.length) return { anchor, action: "dangling", to: [anchor], note: `${note}, but ${dead.join(", ")} matches nothing in the new tree` };
  return { anchor, action: "rewrite", to: targets.map(qualify), note };
}

export type RowChange = { table: "nodes" | "docs"; id: string; name: string; anchors: AnchorPlan[]; newAnchors: string[]; hashes: { kept: number; moved: number; dropped: number } };
export type Report = { project: string; changes: RowChange[]; unresolved: { where: string; plan: AnchorPlan }[]; drafts: number; applied: boolean };

/** The paths in a sentence ("src/lib/service.ts changed in abc1234"), moved. Only whole paths: one already at its new place is not moved again. */
export function rewritePaths(text: string, renames: Map<string, string>): string {
  let out = text;
  for (const [from, to] of [...renames].sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`(?<![\\w./-])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g"), to);
  }
  return out;
}

/** Where a described file went: renamed, or where it was. Null when it is gone (the baseline for it is dropped; the node re-baselines at the next landing). */
const movedPath = (p: string, tree: Tree, newSet: Set<string>) => tree.renames.get(p) ?? (newSet.has(p) ? p : null);

/** Plan (and with `apply`, write) the new anchors and baselines of one project's nodes and docs, and of the drafts waiting on them. */
export async function reanchor(q: Q, tree: Tree, rules: Rules, o: { apply: boolean }): Promise<Report> {
  const newSet = new Set(tree.newFiles);
  const [project] = await q(`select id from projects where key = $1`, [rules.project]);
  if (!project) throw new Error(`no project "${rules.project}" in this database`);
  const report: Report = { project: rules.project, changes: [], unresolved: [], drafts: 0, applied: o.apply };
  const planned = new Map<string, AnchorPlan>();
  const planOf = (a: string) => planned.get(a) ?? planned.set(a, planAnchor(a, tree, rules)).get(a)!;
  const rewriteAnchors = (anchors: string[]) => {
    const plans = anchors.map(planOf);
    const next: string[] = [];
    for (const p of plans) for (const t of p.to) if (!next.includes(t)) next.push(t);
    return { plans, next };
  };

  for (const table of ["nodes", "docs"] as const) {
    const label = table === "nodes" ? "name" : "title";
    const rows = await q(
      `select id, ${label} as name, anchors, described_hashes, drift_paths, stale_reason from ${table} where project_id = $1 ${table === "docs" ? "and deleted_at is null" : ""} order by ${label}`,
      [project.id],
    );
    for (const r of rows) {
      const anchors = (r.anchors as string[]) ?? [];
      const hashes = (r.described_hashes as Record<string, string>) ?? {};
      const drift = (r.drift_paths as string[]) ?? [];
      if (!anchors.length && !Object.keys(hashes).length) continue;
      const { plans, next } = rewriteAnchors(anchors);
      for (const p of plans) if (p.action === "unmapped" || p.action === "dangling") report.unresolved.push({ where: `${table === "nodes" ? "node" : "doc"} "${r.name}"`, plan: p });
      // The baseline follows the files git says moved. If an anchor was rewritten by a RULE (the code was rewritten, not moved: a Next page
      // that is now a React page), the old hashes say nothing about the new files, and a baseline that covers only some of what is anchored
      // would flag the rest as changed at the first landing. So that row starts over with no baseline: the next landing records one without
      // flagging anything. A row whose anchors all just moved keeps its baseline, so a file that really changed still shows as changed.
      const byRule = plans.some((p) => p.action === "rewrite" && p.note === "by rule");
      const newHashes: Record<string, string> = {};
      let moved = 0;
      let dropped = 0;
      for (const [p, h] of Object.entries(hashes)) {
        const to = byRule ? null : movedPath(normPath(p), tree, newSet);
        if (to && next.some((a) => anchorScore(a, to) > 0)) {
          newHashes[to] = h;
          if (to !== p) moved++;
        } else dropped++;
      }
      const newDrift = byRule ? [] : [...new Set(drift.map((p) => movedPath(normPath(p), tree, newSet)).filter((p): p is string => !!p && next.some((a) => anchorScore(a, p) > 0)))];
      let reason = (r.stale_reason as string | null) ?? null;
      if (reason) reason = rewritePaths(reason, tree.renames);
      const changed = JSON.stringify(next) !== JSON.stringify(anchors) || JSON.stringify(newHashes) !== JSON.stringify(hashes) || JSON.stringify(newDrift) !== JSON.stringify(drift) || reason !== r.stale_reason;
      if (!changed) continue;
      report.changes.push({ table, id: String(r.id), name: String(r.name), anchors: plans.filter((p) => p.action !== "keep" && p.action !== "outside"), newAnchors: next, hashes: { kept: Object.keys(newHashes).length - moved, moved, dropped } });
      if (o.apply) {
        await q(`update ${table} set anchors = $1::jsonb, described_hashes = $2::jsonb, drift_paths = $3::jsonb, stale_reason = $4 where id = $5`, [JSON.stringify(next), JSON.stringify(newHashes), JSON.stringify(newDrift), reason, r.id]);
      }
    }
  }

  // A draft waiting to be published carries anchors of its own.
  for (const table of ["node_drafts", "doc_drafts"] as const) {
    const drafts = await q(`select id, patch from ${table} where project_id = $1 and status = 'pending' and patch ? 'anchors'`, [project.id]);
    for (const d of drafts) {
      const patch = d.patch as { anchors?: string[] };
      if (!Array.isArray(patch.anchors)) continue;
      const { next } = rewriteAnchors(patch.anchors);
      if (JSON.stringify(next) === JSON.stringify(patch.anchors)) continue;
      report.drafts++;
      if (o.apply) await q(`update ${table} set patch = $1::jsonb where id = $2`, [JSON.stringify({ ...patch, anchors: next }), d.id]);
    }
  }
  return report;
}

/** The report as text for a person to review. */
export function formatReport(r: Report): string {
  const out: string[] = [`Project ${r.project}: ${r.applied ? "APPLIED" : "dry run (nothing written)"}`];
  for (const c of r.changes) {
    out.push(`\n${c.table === "nodes" ? "node" : "doc "} ${c.name}`);
    for (const p of c.anchors) out.push(`   ${p.action.padEnd(8)} ${p.anchor}${p.action === "rewrite" ? `  ->  ${p.to.join(", ")}` : ""}   (${p.note})`);
    out.push(`   baseline: ${c.hashes.moved} moved, ${c.hashes.kept} unchanged, ${c.hashes.dropped} dropped (the file is gone or was rewritten)`);
  }
  if (r.drafts) out.push(`\n${r.drafts} pending draft(s) had their anchors rewritten`);
  if (r.unresolved.length) {
    out.push(`\nUNRESOLVED (${r.unresolved.length}): left as they are, add a rule for each`);
    for (const u of r.unresolved) out.push(`   ${u.where}: ${u.plan.anchor}: ${u.plan.note}`);
  } else out.push(`\nEvery anchor is kept, rewritten, or belongs to another repository, and each now matches a file in the new tree.`);
  return out.join("\n");
}
