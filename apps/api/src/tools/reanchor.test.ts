/**
 * Re-anchoring (WH-101): git says what moved, a short rules file says what git cannot know, and every anchor ends up kept, rewritten, or
 * reported. Uses a real throwaway git repository and a real database.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openConn, type Conn } from "./db-copy";
import { formatReport, gitTree, planAnchor, reanchor, rewritePaths, type Rules, type Tree } from "./reanchor";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "wh-reanchor-"));
const repo = path.join(work, "repo");
let tree: Tree;
let conn: Conn;
let wh = "";
let other = "";

const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
const write = (f: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
  fs.writeFileSync(path.join(repo, f), content);
};

const rules: Rules = {
  team: "WH",
  repository: ["wheelhouse"],
  anchors: { "src/app/**": ["apps/web/**"], "src/app/page.tsx": ["apps/web/src/page.tsx"], "gone/**": ["nowhere/**"] },
};

before(async () => {
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@example.test");
  sh(repo, "config", "user.name", "T");
  const body = (n: string) => `// ${n}\n` + "line\n".repeat(30);
  for (const f of ["src/lib/a.ts", "src/lib/b.ts", "src/lib/keep.ts", "src/db/schema.ts", "src/db/index.ts", "drizzle/0000_init.sql", "src/app/page.tsx", "README.md"]) write(f, body(f));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "before");
  sh(repo, "tag", "before");
  // The move: a file renamed, a file renamed and edited, a directory renamed, a page rewritten as a new file, one file left alone.
  fs.mkdirSync(path.join(repo, "packages/core/src"), { recursive: true });
  sh(repo, "mv", "src/lib/a.ts", "packages/core/src/lib-a.ts");
  sh(repo, "mv", "src/lib/b.ts", "packages/core/src/lib-b.ts");
  fs.appendFileSync(path.join(repo, "packages/core/src/lib-b.ts"), "// edited a little\n");
  sh(repo, "mv", "src/db", "packages/core/src/db");
  sh(repo, "mv", "drizzle", "packages/core/drizzle");
  sh(repo, "rm", "-q", "src/app/page.tsx");
  write("apps/web/src/page.tsx", "export const Page = () => null;\n");
  write("apps/web/src/other.tsx", "export const Other = () => null;\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "after");
  tree = gitTree(repo, "before", "HEAD");

  conn = await openConn(path.join(work, "db"), { migrate: true, create: true });
  const q = conn.query;
  const [workspace] = await q(`insert into workspaces (name) values ('t') returning id`);
  const [p1] = await q(`insert into teams (workspace_id, key, name) values ($1, 'WH', 'W') returning id`, [workspace.id]);
  const [p2] = await q(`insert into teams (workspace_id, key, name) values ($1, 'OT', 'O') returning id`, [workspace.id]);
  wh = String(p1.id);
  other = String(p2.id);
  const node = async (team: unknown, name: string, anchors: string[], hashes: Record<string, string> = {}, extra: { drift?: string[]; reason?: string } = {}) =>
    (await q(`insert into nodes (team_id, workspace_id, layer, kind, name, anchors, described_hashes, drift_paths, stale, stale_reason) select $1::uuid, workspace_id, 'system', 'service', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7 from teams where id = $1::uuid returning id`, [
      team, name, JSON.stringify(anchors), JSON.stringify(hashes), JSON.stringify(extra.drift ?? []), !!extra.reason, extra.reason ?? null,
    ]))[0].id;
  await node(p1.id, "Lib", ["src/lib/a.ts", "src/lib/b.ts", "src/lib/keep.ts"], { "src/lib/a.ts": "h-a", "src/lib/b.ts": "h-b", "src/lib/keep.ts": "h-k" }, { drift: ["src/lib/b.ts"], reason: "src/lib/b.ts changed in abc1234" });
  await node(p1.id, "Data", ["src/db/**", "drizzle/**", "src/db/schema.ts#docs"], { "src/db/schema.ts": "h-s", "drizzle/0000_init.sql": "h-d" });
  await node(p1.id, "Pages", ["src/app/**", "src/app/page.tsx"], { "src/app/page.tsx": "h-p" });
  await node(p1.id, "Whole", ["wheelhouse:**", "backend:src/**", "cli:src/**"]);
  await node(p1.id, "Lost", ["no/such/**", "gone/**"], { "no/such/x.ts": "h-x" });
  await node(other, "Elsewhere", ["src/lib/a.ts", "src/db/**"], { "src/lib/a.ts": "h-o" });
  await q(`insert into docs (team_id, workspace_id, slug, title, created_by_kind, updated_by_kind, anchors, described_hashes) select $1::uuid, workspace_id, 'd', 'Doc', 'human', 'human', $2::jsonb, $3::jsonb from teams where id = $1::uuid`, [wh, JSON.stringify(["src/lib/a.ts"]), JSON.stringify({ "src/lib/a.ts": "h-doc" })]);
  const [n1] = await q(`select id from nodes where name = 'Lib'`);
  await q(`insert into node_drafts (team_id, workspace_id, node_id, author_name, author_kind, patch) select $1::uuid, workspace_id, $2::uuid, 'Claude', 'agent', $3::jsonb from teams where id = $1::uuid`, [wh, n1.id, JSON.stringify({ anchors: ["src/lib/a.ts"], summary: "s" })]);
});

after(async () => {
  await conn.close();
  fs.rmSync(work, { recursive: true, force: true });
});

describe("what git says moved", () => {
  test("renames, with or without an edit; the rest of the tree at both ends", () => {
    assert.equal(tree.renames.get("src/lib/a.ts"), "packages/core/src/lib-a.ts");
    assert.equal(tree.renames.get("src/lib/b.ts"), "packages/core/src/lib-b.ts", "an edited file is still the same file");
    assert.equal(tree.renames.get("src/db/schema.ts"), "packages/core/src/db/schema.ts");
    assert.equal(tree.renames.has("src/app/page.tsx"), false, "a page rewritten as a new file is not a rename");
    assert.ok(tree.oldFiles.includes("src/app/page.tsx") && !tree.newFiles.includes("src/app/page.tsx"));
    assert.ok(tree.newFiles.includes("apps/web/src/page.tsx"));
  });
});

describe("one anchor", () => {
  const plan = (a: string, r: Rules = rules) => planAnchor(a, tree, r);

  test("a file that did not move is kept; a renamed one is rewritten", () => {
    assert.deepEqual(plan("src/lib/keep.ts"), { anchor: "src/lib/keep.ts", action: "keep", to: ["src/lib/keep.ts"], note: "the file is where it was" });
    assert.deepEqual([plan("src/lib/a.ts").action, plan("src/lib/a.ts").to], ["rewrite", ["packages/core/src/lib-a.ts"]]);
  });
  test("a directory that was renamed becomes the new directory, with the glob it had", () => {
    assert.deepEqual(plan("src/db/**").to, ["packages/core/src/db/**"]);
    assert.deepEqual(plan("drizzle/**").to, ["packages/core/drizzle/**"]);
    assert.equal(plan("src/db/**").note, "the directory was renamed");
  });
  test("a directory that stayed where it is is kept even when files inside it were renamed or removed; one that lost files to somewhere else is not", () => {
    const t: Tree = {
      oldFiles: ["apps/api/src/a.ts", "apps/api/src/web/team.controller.ts", "apps/api/src/web/gone.ts", "src/x/one.ts", "src/x/two.ts"],
      newFiles: ["apps/api/src/a.ts", "apps/api/src/web/workspace.controller.ts", "src/y/one.ts", "src/x/two.ts"],
      renames: new Map([["apps/api/src/web/team.controller.ts", "apps/api/src/web/workspace.controller.ts"], ["src/x/one.ts", "src/y/one.ts"]]),
    };
    const p = planAnchor("apps/api/**", t, rules);
    assert.equal(p.action, "keep");
    assert.match(p.note, /some files inside it were renamed or removed/);
    assert.equal(planAnchor("apps/api/src/web/**", t, rules).action, "keep");
    assert.equal(planAnchor("src/x/**", t, rules).action, "unmapped", "one of its files went to src/y: nobody guesses");
  });
  test("a #symbol suffix and a repo qualifier survive the rewrite", () => {
    assert.deepEqual(plan("src/db/schema.ts#docs").to, ["packages/core/src/db/schema.ts#docs"]);
    assert.deepEqual(plan("wheelhouse:src/lib/a.ts").to, ["wheelhouse:packages/core/src/lib-a.ts"]);
  });
  test("an anchor of another repository is left alone, and one that names the whole repository is kept", () => {
    assert.equal(plan("backend:src/**").action, "outside");
    assert.equal(plan("wheelhouse:**").action, "keep");
    assert.equal(plan("**").note, "it names the whole repository");
  });
  test("a rule says where rewritten code went; one anchor can become several", () => {
    assert.deepEqual(plan("src/app/page.tsx").to, ["apps/web/src/page.tsx"]);
    const many = plan("src/app/**", { ...rules, anchors: { "src/app/**": ["apps/web/**", "apps/web/src/page.tsx"] } });
    assert.deepEqual(many.to, ["apps/web/**", "apps/web/src/page.tsx"]);
  });
  test("nothing is guessed: no rename and no rule is 'unmapped'; a rule that points at nothing is 'dangling'", () => {
    assert.equal(plan("no/such/**").action, "unmapped");
    assert.equal(plan("gone/**").action, "dangling");
    assert.match(plan("gone/**").note, /nowhere\/\*\* matches nothing in the new tree/);
  });
  test("a path in a sentence moves once, and never again", () => {
    const text = "src/lib/a.ts changed in abc1234";
    const once = rewritePaths(text, tree.renames);
    assert.equal(once, "packages/core/src/lib-a.ts changed in abc1234");
    assert.equal(rewritePaths(once, tree.renames), once);
  });
});

describe("a team's nodes and docs", () => {
  const rowOf = async (name: string) => (await conn.query(`select anchors, described_hashes, drift_paths, stale_reason from nodes where name = $1`, [name]))[0];

  test("a dry run writes nothing and reports what it would do; the unresolved are named", async () => {
    const before = JSON.stringify(await conn.query(`select * from nodes order by name`));
    const r = await reanchor(conn.query, tree, rules, { apply: false });
    assert.equal(JSON.stringify(await conn.query(`select * from nodes order by name`)), before);
    assert.deepEqual(r.unresolved.map((u) => [u.where, u.plan.anchor, u.plan.action]), [['node "Lost"', "no/such/**", "unmapped"], ['node "Lost"', "gone/**", "dangling"]]);
    const text = formatReport(r);
    assert.match(text, /dry run \(nothing written\)/);
    assert.match(text, /UNRESOLVED \(2\)/);
  });

  test("applying rewrites anchors; the baseline follows the files that moved; text about them follows too", async () => {
    await reanchor(conn.query, tree, rules, { apply: true });
    const lib = await rowOf("Lib");
    assert.deepEqual(lib.anchors, ["packages/core/src/lib-a.ts", "packages/core/src/lib-b.ts", "src/lib/keep.ts"]);
    assert.deepEqual(lib.described_hashes, { "packages/core/src/lib-a.ts": "h-a", "packages/core/src/lib-b.ts": "h-b", "src/lib/keep.ts": "h-k" });
    assert.deepEqual(lib.drift_paths, ["packages/core/src/lib-b.ts"]);
    assert.equal(lib.stale_reason, "packages/core/src/lib-b.ts changed in abc1234");
    const data = await rowOf("Data");
    assert.deepEqual(data.anchors, ["packages/core/src/db/**", "packages/core/drizzle/**", "packages/core/src/db/schema.ts#docs"]);
    assert.deepEqual(data.described_hashes, { "packages/core/src/db/schema.ts": "h-s", "packages/core/drizzle/0000_init.sql": "h-d" });
  });

  test("code that was rewritten, not moved, starts over with no baseline, so the next landing flags nothing falsely", async () => {
    const pages = await rowOf("Pages");
    assert.deepEqual(pages.anchors, ["apps/web/**", "apps/web/src/page.tsx"]);
    assert.deepEqual(pages.described_hashes, {});
  });

  test("anchors of the whole repository and of other repositories are untouched; another team is never touched", async () => {
    assert.deepEqual((await rowOf("Whole")).anchors, ["wheelhouse:**", "backend:src/**", "cli:src/**"]);
    const elsewhere = await rowOf("Elsewhere");
    assert.deepEqual(elsewhere.anchors, ["src/lib/a.ts", "src/db/**"]);
    assert.deepEqual(elsewhere.described_hashes, { "src/lib/a.ts": "h-o" });
  });

  test("docs and the drafts waiting to be published are rewritten too; unresolved anchors are left as they were", async () => {
    const [doc] = await conn.query(`select anchors, described_hashes from docs`);
    assert.deepEqual([doc.anchors, doc.described_hashes], [["packages/core/src/lib-a.ts"], { "packages/core/src/lib-a.ts": "h-doc" }]);
    const [draft] = await conn.query(`select patch from node_drafts`);
    assert.deepEqual(draft.patch, { anchors: ["packages/core/src/lib-a.ts"], summary: "s" });
    assert.deepEqual((await rowOf("Lost")).anchors, ["no/such/**", "gone/**"]);
  });

  test("running it again changes nothing (no path is moved twice)", async () => {
    const before = JSON.stringify(await conn.query(`select * from nodes order by name`));
    const again = await reanchor(conn.query, tree, rules, { apply: true });
    assert.deepEqual(again.changes, []);
    assert.equal(again.drafts, 0);
    assert.equal(JSON.stringify(await conn.query(`select * from nodes order by name`)), before);
  });

  test("a team that does not exist is an error, not a silent success", async () => {
    await assert.rejects(reanchor(conn.query, tree, { ...rules, team: "NOPE" }, { apply: false }), /no team "NOPE"/);
  });
});
void other;
