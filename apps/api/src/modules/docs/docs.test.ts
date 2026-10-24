/**
 * Workspace documentation (WH-51): service-layer CRUD/locking/tree/limits, tool-layer
 * permissions and the prompt-injection-hygiene output marker, and search ranking/budget.
 * Cross-workspace isolation for docs lives in isolation.test.ts (shares its two-workspace fixture
 * and attack registry); this file is single-workspace, focused on docs' own behaviour.
 */
process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

import crypto from "node:crypto";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { sha256 } from "../../common/crypto";
import { scopeKeyToAllTeams } from "../auth/key-scope";
import { ServiceError } from "../../common/service-error";
import { getChanges, listEvents } from "../../lib/service-queue";
import { anchorScore, reportChanges } from "../map/freshness";
import { upsertNode } from "../map/graph";
import { createTeam, requireTeam } from "../teams/teams.legacy";
import { createDoc, deleteDoc, extractPathTokens, getDoc, linkDocNode, listDocs, markDocFresh, moveDoc, searchDocs, suggestDocAnchors, updateDoc } from "./docs";
import { runTool } from "../../lib/tools";
import * as sync from "../map/sync";
import { testApp } from "../../test/app";
await testApp();

const RUN = crypto.randomBytes(3).toString("hex");
let human: Actor;
let readOnlyAgent: Actor;
let writerAgent: Actor;
let teamKey: string;

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: `docs workspace ${RUN}` }).returning();
  const [owner] = await db.insert(schema.users).values({ email: `docs-owner-${RUN}@example.com`, name: "Docs owner", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: owner.id, workspaceId: workspace.id, role: "owner" });
  human = { kind: "human", id: owner.id, name: "Docs owner", workspaceId: workspace.id };

  const roKey = `wh_${crypto.randomBytes(18).toString("base64url")}`;
  const [ro] = await db.insert(schema.apiKeys).values({ workspaceId: workspace.id, name: "read-only key", prefix: roKey.slice(0, 10), keyHash: sha256(roKey), createdBy: owner.id }).returning();
  readOnlyAgent = { kind: "agent", id: ro.id, name: "read-only key", workspaceId: workspace.id };

  const wKey = `wh_${crypto.randomBytes(18).toString("base64url")}`;
  const [w] = await db
    .insert(schema.apiKeys)
    .values({ workspaceId: workspace.id, name: "writer key", prefix: wKey.slice(0, 10), keyHash: sha256(wKey), createdBy: owner.id, capabilities: ["docs:write"] })
    .returning();
  writerAgent = { kind: "agent", id: w.id, name: "writer key", workspaceId: workspace.id };

  const team = await createTeam(human, { name: "Docs team", key: "DP" });
  teamKey = team.key;
  for (const a of [readOnlyAgent, writerAgent]) await scopeKeyToAllTeams(db, a.id, workspace.id);
});

describe("service layer: CRUD, locking, tree, limits", () => {
  test("createDoc assigns a slug and emits doc.created", async () => {
    const before = await listEvents(human, teamKey, { limit: 1 });
    const d = await createDoc(human, teamKey, { title: "Runbook: Deploys", body: "# Deploys\nHow we deploy." });
    assert.equal(d.slug, "runbook-deploys");
    assert.equal(d.version, 1);
    assert.equal(d.parentId, null);
    const after = await listEvents(human, teamKey, { limit: 1 });
    assert.equal(after[0].type, "doc.created");
    assert.notEqual(after[0].seq, before[0]?.seq);
  });

  test("two docs with the same title get distinct slugs", async () => {
    const a = await createDoc(human, teamKey, { title: "Onboarding" });
    const b = await createDoc(human, teamKey, { title: "Onboarding" });
    assert.equal(a.slug, "onboarding");
    assert.equal(b.slug, "onboarding-2");
  });

  test("updateDoc bumps the version and rejects a stale expected_version", async () => {
    const d = await createDoc(human, teamKey, { title: "Conventions", body: "v1" });
    const updated = await updateDoc(human, teamKey, d.id, { body: "v2" }, d.version);
    assert.equal(updated.version, 2);
    assert.equal(updated.body, "v2");
    await assert.rejects(
      () => updateDoc(human, teamKey, d.id, { body: "v3" }, 1 /* stale */),
      (e: unknown) => e instanceof ServiceError && e.code === "conflict",
    );
    // the conflict must not have applied
    const { doc: reread } = await getDoc(human, teamKey, d.id);
    assert.equal(reread.body, "v2");
  });

  test("a tree: children list under their parent, and nesting past the max depth is refused", async () => {
    // root is depth 0; each child below adds one level. DOC_MAX_DEPTH (4) caps how deep a *new* doc's
    // parent chain may already be, so the 5th level (parent already at depth 4) must be refused.
    const root = await createDoc(human, teamKey, { title: "Tree root" });
    let parent = root;
    for (let i = 0; i < 4; i++) {
      parent = await createDoc(human, teamKey, { title: `Level ${i + 1}`, parent: parent.id });
    }
    await assert.rejects(
      () => createDoc(human, teamKey, { title: "Too deep", parent: parent.id }),
      (e: unknown) => e instanceof ServiceError && e.code === "invalid" && /nest/.test(e.message),
    );
    const children = await listDocs(human, teamKey, root.id);
    assert.equal(children.length, 1);
    assert.equal(children[0].title, "Level 1");
  });

  test("moveDoc re-parents and refuses moving a doc under its own descendant", async () => {
    const parentA = await createDoc(human, teamKey, { title: "Parent A" });
    const parentB = await createDoc(human, teamKey, { title: "Parent B" });
    const child = await createDoc(human, teamKey, { title: "Child", parent: parentA.id });
    const moved = await moveDoc(human, teamKey, child.id, { parent: parentB.id });
    assert.equal(moved.parentId, parentB.id);
    await assert.rejects(
      () => moveDoc(human, teamKey, parentB.id, { parent: child.id }),
      (e: unknown) => e instanceof ServiceError && e.code === "invalid",
    );
  });

  test("moveDoc with an index swaps sibling order (WH-82 reorder controls)", async () => {
    // Nest under a fresh parent so A/B/C are the only siblings — the team otherwise has many
    // top-level docs from earlier tests, which would make an index relative to "all top-level docs" meaningless.
    const parent = await createDoc(human, teamKey, { title: "Reorder parent" });
    await createDoc(human, teamKey, { title: "A", parent: parent.id });
    await createDoc(human, teamKey, { title: "B", parent: parent.id });
    const c = await createDoc(human, teamKey, { title: "C", parent: parent.id });
    const order = async () => (await listDocs(human, teamKey, parent.id)).map((d) => d.title);
    assert.deepEqual(await order(), ["A", "B", "C"]);
    // Move "C" up one slot, past "B": siblings excludes the doc being moved ([A, B]), so index 2 is past
    // both, index 1 lands between them (A, C, B), index 0 would put it before A.
    await moveDoc(human, teamKey, c.id, { index: 1 });
    assert.deepEqual(await order(), ["A", "C", "B"]);
  });

  test("deleteDoc soft-deletes it (and nested docs), and it disappears from listDocs", async () => {
    const parent = await createDoc(human, teamKey, { title: "To delete" });
    const child = await createDoc(human, teamKey, { title: "Nested child", parent: parent.id });
    await deleteDoc(human, teamKey, parent.id);
    const db = await getDb();
    const [row] = await db.select().from(schema.docs).where(eq(schema.docs.id, parent.id));
    assert.ok(row?.deletedAt, "deletedAt is set, the row is not hard-deleted");
    const [childRow] = await db.select().from(schema.docs).where(eq(schema.docs.id, child.id));
    assert.ok(childRow?.deletedAt, "nested docs are soft-deleted too");
    await assert.rejects(() => getDoc(human, teamKey, parent.id), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    const all = await listDocs(human, teamKey);
    assert.ok(!all.some((d) => d.id === parent.id || d.id === child.id));
  });

  test("body over 200KB is refused", async () => {
    const big = "x".repeat(200_001);
    await assert.rejects(
      () => createDoc(human, teamKey, { title: "Too big", body: big }),
      (e: unknown) => e instanceof ServiceError && e.code === "invalid" && /200/.test(e.message),
    );
  });

  test("a team at the 500-doc cap refuses further creates", async () => {
    const db = await getDb();
    const [capTeam] = await db.insert(schema.teams).values({ workspaceId: human.workspaceId, key: "CAP", name: "Cap team" }).returning();
    await db.insert(schema.teamMembers).values({ teamId: capTeam.id, userId: human.id, workspaceId: human.workspaceId, role: "editor" }); // a team is reachable only by its members
    // Insert 500 docs directly (fast path) rather than through the service, to keep the test quick.
    const rows = Array.from({ length: 500 }, (_, i) => ({
      teamId: capTeam.id,
      workspaceId: capTeam.workspaceId,
      slug: `doc-${i}`,
      title: `Doc ${i}`,
      createdByKind: "human" as const,
      createdById: human.id,
      updatedByKind: "human" as const,
      updatedById: human.id,
      position: i,
    }));
    await db.insert(schema.docs).values(rows);
    await assert.rejects(
      () => createDoc(human, "CAP", { title: "One too many" }),
      (e: unknown) => e instanceof ServiceError && e.code === "invalid" && /500/.test(e.message),
    );
  });
});

describe("tool layer: permissions and the untrusted-content marker", () => {
  test("a read-only key can list_docs, get_doc and search_docs", async () => {
    await createDoc(human, teamKey, { title: "Readable by anyone", body: "anyone can read this" });
    const list = await runTool(readOnlyAgent, "list_docs", { project: teamKey });
    assert.ok(Array.isArray(list));
    const found = (list as { slug: string }[]).find((d) => d.slug === "readable-by-anyone")!;
    const got = (await runTool(readOnlyAgent, "get_doc", { project: teamKey, doc: found.slug })) as { body: string };
    assert.match(got.body, /<untrusted-document-content/);
    assert.match(got.body, /anyone can read this/);
  });

  test("a read-only key is refused on upsert_doc and delete_doc with a clear forbidden error", async () => {
    await assert.rejects(
      () => runTool(readOnlyAgent, "upsert_doc", { project: teamKey, title: "Should fail" }),
      (e: unknown) => e instanceof ServiceError && e.code === "forbidden" && /docs:write/.test(e.message),
    );
    const d = await createDoc(human, teamKey, { title: "Protected doc" });
    await assert.rejects(
      () => runTool(readOnlyAgent, "delete_doc", { project: teamKey, doc: d.id }),
      (e: unknown) => e instanceof ServiceError && e.code === "forbidden",
    );
  });

  test("a key with docs:write can create, update and delete", async () => {
    const created = (await runTool(writerAgent, "upsert_doc", { project: teamKey, title: "Agent-written doc", body: "hello" })) as { id: string; version: number };
    assert.ok(created.id);
    const updated = (await runTool(writerAgent, "upsert_doc", {
      project: teamKey,
      doc: created.id,
      body: "hello v2",
      expected_version: created.version,
    })) as { version: number };
    assert.equal(updated.version, 2);
    const deleted = (await runTool(writerAgent, "delete_doc", { project: teamKey, doc: created.id })) as { ok: boolean };
    assert.ok(deleted.ok);
  });

  test("a human (no key capability check) can always write", async () => {
    const d = (await runTool(human, "upsert_doc", { project: teamKey, title: "Human doc" })) as { id: string };
    assert.ok(d.id);
  });

  test("search_docs wraps every snippet with the untrusted-content marker", async () => {
    await createDoc(human, teamKey, { title: "Marker check", body: "a distinctive needle-phrase appears here" });
    const res = (await runTool(readOnlyAgent, "search_docs", { project: teamKey, query: "needle-phrase" })) as {
      results: { snippet: string }[];
    };
    assert.ok(res.results.length > 0);
    for (const r of res.results) assert.match(r.snippet, /<untrusted-document-content/);
  });
});

describe("search ranking and token budget", () => {
  test("a title match ranks above a body-only match", async () => {
    await createDoc(human, teamKey, { title: "Zzyzx is great", body: "unrelated content" });
    await createDoc(human, teamKey, { title: "Something else", body: "this body merely mentions zzyzx once" });
    const res = await searchDocs(human, teamKey, "zzyzx");
    assert.ok(res.results.length >= 2);
    assert.equal(res.results[0].title, "Zzyzx is great");
  });

  test("a word only in the body is still found", async () => {
    await createDoc(human, teamKey, { title: "Plain title", body: "the unmistakable-term lives only in the body" });
    const res = await searchDocs(human, teamKey, "unmistakable-term");
    assert.ok(res.results.some((r) => r.title === "Plain title"));
  });

  test("max_tokens caps the returned result set", async () => {
    for (let i = 0; i < 10; i++) {
      await createDoc(human, teamKey, { title: `Budget doc ${i} budgetword`, body: "budgetword ".repeat(200) });
    }
    const wide = await searchDocs(human, teamKey, "budgetword", { maxTokens: 4000 });
    const narrow = await searchDocs(human, teamKey, "budgetword", { maxTokens: 50 });
    assert.ok(narrow.results.length <= wide.results.length);
    assert.ok(narrow.truncated || narrow.results.length < 10);
  });
});

/**
 * Living docs freshness (WH-64): the same anchorScore/parseAnchor mechanism used
 * for map nodes, reused for docs — anchoring, flagging via report_changes/land,
 * clearing via updateDoc/markDocFresh, and the doc-draft flow mirroring node drafts.
 */
describe("anchorScore reused against docs' own anchors (no regression)", () => {
  test("a doc anchored to a path matches the same way a node would", async () => {
    const d = await createDoc(human, teamKey, { title: "Anchor sanity", anchors: ["src/lib/auth.ts"] });
    assert.ok(anchorScore(d.anchors[0], "src/lib/auth.ts") > 0);
    assert.equal(anchorScore(d.anchors[0], "src/lib/other.ts"), 0);
  });

  test("a glob anchor on a doc matches a directory the same way", async () => {
    const d = await createDoc(human, teamKey, { title: "Glob anchor", anchors: ["src/lib/**"] });
    assert.ok(anchorScore(d.anchors[0], "src/lib/deep/file.ts") > 0);
  });
});

describe("extractPathTokens / suggestDocAnchors", () => {
  test("pulls inline-code and bare path tokens out of markdown", () => {
    const tokens = extractPathTokens("See `src/lib/auth.ts` and src/app/actions.ts, plus notes on src/lib/**.");
    assert.ok(tokens.includes("src/lib/auth.ts"));
    assert.ok(tokens.includes("src/app/actions.ts"));
    assert.ok(tokens.includes("src/lib/**"));
  });

  test("plain prose without path-like tokens yields nothing", () => {
    assert.deepEqual(extractPathTokens("Just a normal sentence about deploys and runbooks."), []);
  });

  test("suggestDocAnchors surfaces body tokens and linked nodes' anchors, never the doc's own existing anchors", async () => {
    const node = await upsertNode(human, teamKey, { name: `Auth service ${RUN}`, layer: "system", anchors: ["src/lib/auth.ts"] });
    const d = await createDoc(human, teamKey, { title: "Auth runbook", body: "Restart with `src/scripts/restart.sh`.", anchors: ["src/scripts/restart.sh"] });
    await linkDocNode(human, teamKey, d.id, node.name);
    const suggestions = await suggestDocAnchors(human, teamKey, d.id);
    assert.ok(suggestions.includes("src/lib/auth.ts"), "the linked node's anchor is suggested");
    assert.ok(!suggestions.includes("src/scripts/restart.sh"), "an anchor already on the doc is not suggested again");
  });

  test("suggestions are never auto-applied: creating/updating a doc never sets anchors on its own", async () => {
    const d = await createDoc(human, teamKey, { title: "No auto anchors", body: "mentions src/lib/auth.ts in passing" });
    assert.deepEqual(d.anchors, []);
  });
});

describe("flagging: report_changes and land flag anchored docs, parallel to nodes", () => {
  test("report_changes flags a doc anchored to a changed file, with a reason, and leaves unanchored docs alone", async () => {
    const anchored = await createDoc(human, teamKey, { title: "Anchored to auth", anchors: ["src/lib/auth.ts"] });
    const unanchored = await createDoc(human, teamKey, { title: "Not anchored at all" });
    const result = await reportChanges(human, teamKey, { files: ["src/lib/auth.ts"], sha: "a".repeat(40), summary: "refactored login" });
    assert.ok(result.staleDocsMarked.some((m) => m.id === anchored.id));
    assert.ok(!result.staleDocsMarked.some((m) => m.id === unanchored.id));

    const { doc: a } = await getDoc(human, teamKey, anchored.id);
    assert.equal(a.stale, true);
    assert.equal(a.staleSource, "report");
    assert.match(a.staleReason ?? "", /src\/lib\/auth\.ts/);
    assert.match(a.staleReason ?? "", /refactored login/);

    const { doc: u } = await getDoc(human, teamKey, unanchored.id);
    assert.equal(u.stale, false, "an unanchored doc is never flagged");
  });

  test("land() flags a doc via drift when its landed content differs from what it was described against, and clears on revert", async () => {
    const db = await getDb();
    await db.insert(schema.teamFiles).values({ teamId: (await requireTeam(human, teamKey)).id, workspaceId: human.workspaceId, path: "src/lib/billing.ts", hash: "1".repeat(40) });
    const d = await createDoc(human, teamKey, { title: "Billing doc", anchors: ["src/lib/billing.ts"] });
    const { doc: initial } = await getDoc(human, teamKey, d.id);
    assert.equal(initial.describedHashes["src/lib/billing.ts"], "1".repeat(40), "baseline hash captured at creation");

    const landed = await sync.land(human, teamKey, { files: { "src/lib/billing.ts": "2".repeat(40) }, sha: "b".repeat(40) });
    assert.ok(landed.staleDocs.includes(d.slug));
    const { doc: afterDrift } = await getDoc(human, teamKey, d.id);
    assert.equal(afterDrift.stale, true);
    assert.equal(afterDrift.staleSource, "drift");

    const reverted = await sync.land(human, teamKey, { files: { "src/lib/billing.ts": "1".repeat(40) }, sha: "c".repeat(40) });
    assert.ok(reverted.freshDocs.includes(d.slug));
    const { doc: afterRevert } = await getDoc(human, teamKey, d.id);
    assert.equal(afterRevert.stale, false, "reverting to the described content clears the drift flag");
  });
});

describe("clearing: updateDoc and mark_doc_fresh clear the stale flag, with history", () => {
  test("editing the body clears stale and records a doc.updated event noting it's now fresh", async () => {
    const d = await createDoc(human, teamKey, { title: "Clears on edit", anchors: ["src/lib/x.ts"] });
    await reportChanges(human, teamKey, { files: ["src/lib/x.ts"] });
    assert.equal((await getDoc(human, teamKey, d.id)).doc.stale, true);

    const updated = await updateDoc(human, teamKey, d.id, { body: "re-read and rewritten" });
    assert.equal(updated.stale, false);
    assert.equal(updated.staleReason, null);

    const events = await listEvents(human, teamKey, { limit: 5 });
    assert.ok(events.some((e) => e.type === "doc.updated" && /now fresh/.test(e.summary)));
  });

  test("mark_doc_fresh clears the flag without changing title/body, recording who confirmed via updatedByKind/updatedById", async () => {
    const d = await createDoc(human, teamKey, { title: "Confirm accurate", body: "still true", anchors: ["src/lib/y.ts"] });
    await reportChanges(human, teamKey, { files: ["src/lib/y.ts"] });
    const before = await getDoc(human, teamKey, d.id);
    assert.equal(before.doc.stale, true);

    const confirmed = await markDocFresh(human, teamKey, d.id);
    assert.equal(confirmed.stale, false);
    assert.equal(confirmed.body, "still true", "markFresh never touches content");
    assert.equal(confirmed.updatedByKind, "human");
    assert.equal(confirmed.updatedById, human.id, "who confirmed is recorded via updatedByKind/updatedById");
  });

  test("get_stale_docs / mark_doc_fresh tools work end to end", async () => {
    const d = await createDoc(human, teamKey, { title: "Via tools", anchors: ["src/lib/z.ts"] });
    await reportChanges(human, teamKey, { files: ["src/lib/z.ts"] });
    const stale = (await runTool(human, "get_stale_docs", { project: teamKey })) as { id: string }[];
    assert.ok(stale.some((x) => x.id === d.id));
    await runTool(human, "mark_doc_fresh", { project: teamKey, doc: d.id });
    const staleAfter = (await runTool(human, "get_stale_docs", { project: teamKey })) as { id: string }[];
    assert.ok(!staleAfter.some((x) => x.id === d.id));
  });
});

describe("get_changes / report_changes surface staleDocs alongside staleNodes", () => {
  test("getChanges includes staleDocs for an agent's queue", async () => {
    const d = await createDoc(human, teamKey, { title: "Surfaced in queue", anchors: ["src/lib/queue-surface.ts"] });
    await reportChanges(human, teamKey, { files: ["src/lib/queue-surface.ts"] });
    const changes = await getChanges(writerAgent, teamKey);
    assert.ok(changes.staleDocs.some((x) => x.slug === d.slug));
  });
});

describe("drafts (WH-64): an agent session editing a doc for unlanded code gets a draft, published on land", () => {
  test("an agent's doc edit for in-flux anchored code is stored as a draft, not applied directly, and publishes when the code lands", async () => {
    const sessionId = `doc-draft-session-${RUN}`;
    const d = await createDoc(writerAgent, teamKey, { title: "Draft flow doc", body: "original", anchors: ["src/lib/draftflow.ts"] });
    // The session reports the anchored file as touched (in flux, not landed).
    await sync.sessionSync(writerAgent, teamKey, { session: sessionId, files: ["src/lib/draftflow.ts"] });

    const result = await updateDoc(writerAgent, teamKey, d.id, { body: "agent rewrote this" }, undefined);
    assert.ok((result as { draft?: boolean }).draft, "stored as a draft, not applied directly");
    const { doc: stillOriginal } = await getDoc(human, teamKey, d.id);
    assert.equal(stillOriginal.body, "original", "the shared doc is untouched while the code is still in flux");

    const pending = await sync.listDocDrafts(human, teamKey);
    assert.ok(pending.some((p) => p.docId === d.id && p.status === "pending"));

    // The code lands: the draft publishes automatically.
    const landed = await sync.land(human, teamKey, { files: { "src/lib/draftflow.ts": "d".repeat(40) }, sha: "d".repeat(40) });
    assert.ok(landed.publishedDocs.includes(d.slug));
    const { doc: published } = await getDoc(human, teamKey, d.id);
    assert.equal(published.body, "agent rewrote this");
    assert.equal(published.stale, false);
  });

  test("a draft whose session abandons the file (reverts) is discarded instead of publishing", async () => {
    const sessionId = `doc-draft-abandon-${RUN}`;
    const landedHash = "e".repeat(40);
    const db = await getDb();
    const team = await requireTeam(writerAgent, teamKey);
    await db.insert(schema.teamFiles).values({ teamId: team.id, workspaceId: team.workspaceId, path: "src/lib/abandon.ts", hash: landedHash });
    const d = await createDoc(writerAgent, teamKey, { title: "Abandoned draft doc", body: "v1", anchors: ["src/lib/abandon.ts"] });
    await sync.sessionSync(writerAgent, teamKey, { session: sessionId, files: { "src/lib/abandon.ts": "f".repeat(40) } });
    await updateDoc(writerAgent, teamKey, d.id, { body: "agent draft" }, undefined);

    const [draftRow] = await db.select().from(schema.docDrafts).where(eq(schema.docDrafts.docId, d.id));
    assert.equal(draftRow.status, "pending");

    // The session reports the file reverted to the landed content: it's no longer in flux, so the draft is abandoned.
    await sync.sessionSync(writerAgent, teamKey, { session: sessionId, files: { "src/lib/abandon.ts": landedHash } });
    const [after] = await db.select().from(schema.docDrafts).where(eq(schema.docDrafts.id, draftRow.id));
    assert.equal(after.status, "discarded");
  });
});

describe("owner, contributors and labels (WH-103)", () => {
  test("the owner is who created the doc; contributors are the others who changed it, once each, in order", async () => {
    const d = await createDoc(human, teamKey, { title: "People doc", body: "v1" });
    await updateDoc(human, teamKey, d.id, { body: "v2" });
    await updateDoc(writerAgent, teamKey, d.id, { body: "v3", forcePublish: true });
    await updateDoc(writerAgent, teamKey, d.id, { body: "v4", forcePublish: true });
    const got = await getDoc(human, teamKey, d.id);
    assert.deepEqual(got.owner, { kind: "human", id: human.id, name: "Docs owner" });
    assert.deepEqual(got.contributors, [{ kind: "agent", id: writerAgent.id, name: writerAgent.name }]);
  });

  test("a doc nobody else touched has no contributors", async () => {
    const d = await createDoc(human, teamKey, { title: "Solo doc" });
    assert.deepEqual((await getDoc(human, teamKey, d.id)).contributors, []);
  });

  test("labels are trimmed and de-duplicated, saved with the version, and never mark a doc fresh or change its body", async () => {
    const d = await createDoc(human, teamKey, { title: "Labelled doc", body: "text" });
    const updated = await updateDoc(human, teamKey, d.id, { labels: ["  runbook ", "Ops", "ops", ""] }, d.version);
    assert.deepEqual(updated.labels, ["runbook", "Ops"]);
    assert.equal(updated.body, "text");
    await assert.rejects(() => updateDoc(human, teamKey, d.id, { labels: ["x"] }, d.version), /was changed/);
  });

  test("a label over 40 characters, or more than 20 labels, is refused", async () => {
    const d = await createDoc(human, teamKey, { title: "Too many labels" });
    await assert.rejects(() => updateDoc(human, teamKey, d.id, { labels: ["x".repeat(41)] }), /at most 40/);
    await assert.rejects(() => updateDoc(human, teamKey, d.id, { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }), /at most 20/);
  });
});
