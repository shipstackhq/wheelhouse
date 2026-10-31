/** The combined tools of the MCP redesign (docs/mcp-redesign.md): each one's main path, against in-memory PGlite. */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../db";
import type { Actor } from "../common/actor";
import { ServiceError } from "../common/service-error";
import { scopeKeyToAllTeams } from "../modules/auth/auth.legacy";
import { createIssue } from "../modules/issues/issues.legacy";
import { createTeam } from "../modules/teams/teams.legacy";
import { ToolsService } from "./tools";
import { testApp } from "../test/app";
await testApp();
const mcp = (await testApp()).get(ToolsService);

let human: Actor;
let key: Actor;
const T = "TT";
const call = <R = Record<string, any>>(a: Actor, tool: string, args: Record<string, unknown> = {}) => mcp.run(a, tool, args) as Promise<R>; // eslint-disable-line @typescript-eslint/no-explicit-any
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: "Tools workspace" }).returning();
  const [user] = await db.insert(schema.users).values({ email: `t-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Tess", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
  const [k] = await db.insert(schema.apiKeys).values({ workspaceId: workspace.id, name: "laptop", prefix: "wh_", keyHash: "tools-key" }).returning();
  key = { kind: "agent", id: k.id, name: "laptop", workspaceId: workspace.id };
  human = { kind: "human", id: user.id, name: "Tess", workspaceId: workspace.id };
  await createTeam(human, { name: "Tools team", key: T });
  await scopeKeyToAllTeams(db, k.id, workspace.id);
});

describe("the registry", () => {
  test("22 agent tools, and the six session tools only over REST; every tool takes `team` where it needs one", () => {
    assert.equal(mcp.list().length, 22);
    assert.deepEqual(
      mcp.list({ includeHidden: true }).map((t) => t.name).filter((n) => !mcp.list().some((t) => t.name === n)).sort(),
      ["land_changes", "report_changes", "resume_session", "session_end", "session_status", "session_sync"],
    );
    for (const t of mcp.list({ includeHidden: true })) assert.ok("team" in (t.inputSchema.properties as object) || ["plan", "get_project", "get_issue", "update_issue", "comment", "get_briefing"].includes(t.name), t.name);
    assert.ok(!("create_project" in mcp.tools) && !("search_docs" in mcp.tools));
  });
});

describe("get_issue and update_issue", () => {
  test("get_issue combines the issue, its thread, relatives and the context pack", async () => {
    const parent = await call(human, "create_issue", { team: T, title: "Epic" });
    const child = await call(key, "create_issue", { team: T, title: "Task", parent: parent.ref, body: "do it" });
    await call(key, "comment", { ref: child.ref, body: "on it" });
    const got = await call(key, "get_issue", { ref: child.ref });
    assert.equal(got.issue.title, "Task");
    assert.equal(got.parent.ref, parent.ref);
    assert.equal(got.comments[0].body, "on it");
    assert.match(got.context, /# TT-\d+: Task/);
    assert.deepEqual((await call(key, "get_issue", { ref: parent.ref })).children.map((c: { ref: string }) => c.ref), [child.ref]);
  });

  test("update_issue changes fields, status, assignee (me claims), cycle, project, milestone and node links in one call", async () => {
    await call(human, "plan", {
      changes: [
        { op: "create_cycle", team: T, name: "Now", starts_at: day(-1), ends_at: day(6) },
        { op: "create_project", name: "Launch", lead_team: T },
        { op: "create_milestone", project: "Launch", name: "Beta" },
      ],
    });
    await call(human, "update_map", { team: T, changes: [{ op: "upsert_node", name: "Billing", layer: "system" }] });
    const made = await call(key, "create_issue", { team: T, title: "Charge cards" });

    const done = await call(key, "update_issue", {
      ref: made.ref,
      priority: "high",
      status: "in_progress",
      assignee: "me",
      cycle: "current",
      project: "Launch",
      milestone: "Beta",
      link_nodes: ["Billing"],
      expected_version: made.version,
    });
    assert.equal(done.status, "In Progress");
    assert.equal(done.priority, "high");
    assert.equal(done.claimed, true);
    assert.equal(done.cycle, 1);
    assert.equal(done.project, "Launch");
    assert.equal(done.milestone, "Beta");
    assert.deepEqual(done.nodes, ["Billing"]);

    await assert.rejects(call(key, "update_issue", { ref: made.ref, title: "late", expected_version: made.version }), (e: unknown) => e instanceof ServiceError && e.code === "conflict");
    const cleared = await call(key, "update_issue", { ref: made.ref, cycle: null, project: null, unlink_nodes: ["Billing"] });
    assert.deepEqual([cleared.cycle, cleared.project, cleared.milestone, cleared.nodes], [null, null, null, []]);
  });

  test("a person assigning to me is the assignee, and list_issues filters by it", async () => {
    const t = await call(human, "create_issue", { team: T, title: "Mine", assignee: "me" });
    const mine = await call(human, "list_issues", { team: T, assignee: "me" });
    const refs = mine.issues;
    assert.ok(refs.some((i: { ref: string; assignee: string }) => i.ref === t.ref && i.assignee === "Tess"));
    assert.ok(refs.every((i: { assignee: string }) => i.assignee === "Tess"));
  });
});

describe("get_changes with ack", () => {
  test("acknowledges first, then returns what is left", async () => {
    await createIssue(human, T, { title: "For the queue" });
    const first = await call(key, "get_changes", { team: T });
    assert.ok(first.total > 0);
    const after = await call(key, "get_changes", { team: T, ack: first.latestSeq });
    assert.equal(after.total, 0);
  });
});

describe("the map tools", () => {
  test("update_map applies a batch in order and reports each change; one failure applies nothing", async () => {
    const r = await call(key, "update_map", {
      team: T,
      changes: [
        { op: "upsert_node", name: "Web", layer: "system", summary: "the app" },
        { op: "upsert_node", name: "API", layer: "system", summary: "the server" },
        { op: "upsert_edge", from: "Web", to: "API", label: "REST" },
        { op: "upsert_table", name: "orders", columns: [{ name: "id", type: "uuid", pk: true }, { name: "user_id", type: "uuid", references: "users.id" }] },
        { op: "upsert_table", name: "users", columns: [{ name: "id", type: "uuid", pk: true }] },
        { op: "upsert_flow", name: "Checkout", steps: [{ node: "Web", title: "Click" }, { node: "API", title: "Charge" }] },
      ],
    });
    assert.deepEqual(r.results.map((x: { op: string }) => x.op), ["upsert_node", "upsert_node", "upsert_edge", "upsert_table", "upsert_table", "upsert_flow"]);
    assert.deepEqual(r.unresolved, [], "the foreign key resolves once both tables are in");

    await assert.rejects(
      call(key, "update_map", { team: T, changes: [{ op: "upsert_node", name: "Ghost", layer: "system" }, { op: "remove_node", node: "No such node" }] }),
      (e: unknown) => e instanceof ServiceError && e.code === "not_found" && /change 2 \(remove_node\)/.test(e.message),
    );
    const map = await call(key, "get_map", { team: T, layer: "system" });
    assert.ok(!map.nodes.some((n: { name: string }) => n.name === "Ghost"), "the first change was rolled back");
  });

  test("get_map reads the graph, one node, one flow and the data layer", async () => {
    assert.ok((await call(key, "get_map", { team: T })).nodes.length >= 2);
    assert.equal((await call(key, "get_map", { team: T, node: "API" })).node.name, "API");
    assert.deepEqual((await call(key, "get_map", { team: T, flow: "Checkout" })).steps.map((s: { node: string }) => s.node), ["system:Web", "system:API"]);
    assert.ok(JSON.stringify(await call(key, "get_map", { team: T, layer: "data" })).includes("orders"));
  });

  test("get_stale merges stale nodes and docs, and mark_fresh confirms either", async () => {
    await call(human, "update_map", { team: T, changes: [{ op: "upsert_node", name: "Payments", layer: "system", anchors: ["src/pay/**"] }] });
    await call(human, "write_doc", { team: T, title: "Payments runbook", body: "how", anchors: ["src/pay/charge.ts"] });
    await call(key, "report_changes", { team: T, files: ["src/pay/charge.ts"] });
    const stale = await call(key, "get_stale", { team: T });
    assert.ok(stale.nodes.some((n: { name: string }) => n.name === "Payments"));
    assert.ok(stale.docs.some((d: { ref: string }) => d.ref === "docs/payments-runbook"));
    assert.deepEqual(Object.keys(stale).sort(), ["docDrafts", "docs", "drafts", "nodes"]);

    await call(human, "mark_fresh", { team: T, refs: ["Payments", "docs/payments-runbook"] });
    const after = await call(key, "get_stale", { team: T });
    assert.ok(!after.nodes.some((n: { name: string }) => n.name === "Payments") && !after.docs.some((d: { ref: string }) => d.ref === "docs/payments-runbook"));
  });
});

describe("knowledge tools", () => {
  test("list_knowledge lists docs as a tree of refs, decisions and terms", async () => {
    const parent = await call(human, "write_doc", { team: T, title: "Handbook" });
    await call(human, "write_doc", { team: T, title: "Deploys", parent: parent.ref });
    const docs = await call<{ ref: string; parent: string | null }[]>(key, "list_knowledge", { team: T, kind: "docs" });
    assert.equal(docs.find((d) => d.ref === "docs/deploys")?.parent, "docs/handbook");
    await call(key, "record_decision", { team: T, title: "Use 303", decision: "303 for auth redirects" });
    await call(key, "define_term", { team: T, term: "Cycle", definition: "A time box" });
    assert.ok((await call<{ title: string }[]>(key, "list_knowledge", { team: T, kind: "decisions" })).some((d) => d.title === "Use 303"));
    assert.ok((await call<{ term: string }[]>(key, "list_knowledge", { team: T, kind: "terms" })).some((d) => d.term === "Cycle"));
  });
});

describe("planning tools", () => {
  test("plan creates and edits cycles, projects and milestones; get_project and get_cycle read them, also for a key", async () => {
    const r = await call(human, "plan", {
      changes: [
        { op: "create_cycle", team: T, name: "Next", starts_at: day(10), ends_at: day(16), goal: "ship" },
        { op: "update_cycle", team: T, number: 2, goal: "ship it" },
        { op: "create_project", name: "Roadmap", lead_team: T, description: "the plan" },
        { op: "create_milestone", project: "Roadmap", name: "Alpha", target_date: day(30) },
        { op: "update_milestone", project: "Roadmap", milestone: "Alpha", name: "Alpha 1" },
        { op: "update_project", project: "Roadmap", status: "active" },
      ],
    });
    assert.equal(r.length, 6);
    assert.equal(r[0].cycle, 2);

    const project = await call(key, "get_project", { ref: "Roadmap" });
    assert.equal(project.status, "active");
    assert.deepEqual(project.milestones.map((m: { name: string }) => m.name), ["Alpha 1"]);
    const next = await call(key, "get_cycle", { team: T, which: "next" });
    assert.equal(next.goal, "ship it");
    assert.equal((await call(key, "get_cycle", { team: T, which: 99 }).catch((e) => e)).code, "not_found");
  });

  test("a failing change applies none of the batch", async () => {
    await assert.rejects(
      call(human, "plan", { changes: [{ op: "create_project", name: "Half done", lead_team: T }, { op: "create_milestone", project: "Nope", name: "x" }] }),
      (e: unknown) => e instanceof ServiceError && /change 2/.test(e.message),
    );
    await assert.rejects(call(human, "get_project", { ref: "Half done" }), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
  });

  test("a key needs the planning:write scope", async () => {
    const reader: Actor = { ...key, scopes: ["read", "board:write"] };
    await assert.rejects(call(reader, "plan", { changes: [{ op: "create_cycle", team: T }] }), (e: unknown) => e instanceof ServiceError && e.code === "forbidden" && /planning:write/.test(e.message));
  });
});

describe("get_briefing", () => {
  test("without a team: the teams; with one: the briefing, current cycle, active projects and activity", async () => {
    assert.deepEqual((await call(key, "get_briefing", {})).teams.map((t: { key: string }) => t.key), [T]);
    const b = await call(key, "get_briefing", { team: T });
    assert.match(b.markdown, /# TT: Tools team/);
    assert.equal(b.cycle.name, "Now");
    assert.ok(b.projects.some((p: { name: string }) => p.name === "Launch" || p.name === "Roadmap"));
    assert.ok(Array.isArray(b.activity) && b.activity.length > 0);
  });
});

describe("list_issues", () => {
  const L = "LI";
  const rows = (r: Record<string, any>): string[] => r.issues.map((x: { ref: string }) => x.ref); // eslint-disable-line @typescript-eslint/no-explicit-any
  const byTitle = (r: Record<string, any>): string[] => r.issues.map((x: { title: string }) => x.title); // eslint-disable-line @typescript-eslint/no-explicit-any
  let list: (args?: Record<string, unknown>) => Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  before(async () => {
    await createTeam(human, { name: "List team", key: L });
    await scopeKeyToAllTeams(await getDb(), key.id, key.workspaceId);
    await call(human, "plan", { changes: [{ op: "create_cycle", team: L, starts_at: day(-1), ends_at: day(6) }, { op: "create_project", name: "Apollo", lead_team: L }] });
    const mk = (title: string, extra: Record<string, unknown> = {}) => call(human, "create_issue", { team: L, title, ...extra });
    await mk("low backlog", { priority: "low" });
    await mk("urgent todo", { priority: "urgent", status: "todo", labels: ["bug"] });
    await mk("high mine", { priority: "high", status: "in_progress", assignee: "me", cycle: "current" });
    await mk("medium review", { priority: "medium", status: "review", project: "Apollo" });
    await mk("none backlog");
    await mk("finished", { status: "done", priority: "urgent" });
    await mk("dropped", { status: "canceled" });
    list = (args = {}) => call(human, "list_issues", { team: L, ...args });
  });

  test("counts come first, cover every status, and ignore `limit`", async () => {
    const r = await list({ limit: 1 });
    assert.deepEqual(r.counts, { Backlog: 2, Todo: 1, "In Progress": 1, Review: 1, Done: 1, Canceled: 1, open: 5, done: 1, canceled: 1, total: 7 });
    assert.deepEqual(Object.keys(r), ["counts", "issues", "more", "hint"]);
    assert.deepEqual((await list()).counts, r.counts);
  });

  test("default is open issues; done and canceled are excluded", async () => {
    assert.equal((await list()).issues.length, 5);
    assert.ok(!byTitle(await list()).some((t) => t === "finished" || t === "dropped"));
  });

  test("rows are compact, ordered by priority (none last) then recency", async () => {
    const r = await list();
    assert.deepEqual(byTitle(r), ["urgent todo", "high mine", "medium review", "low backlog", "none backlog"]);
    assert.deepEqual(Object.keys(r.issues[0]).sort(), ["assignee", "cycle", "priority", "ref", "status", "title"]);
    assert.deepEqual(r.issues[1], { ref: r.issues[1].ref, title: "high mine", status: "In Progress", priority: "high", assignee: "Tess", cycle: 1 });
  });

  test("status takes a name, a role, or open; counts ignore it", async () => {
    assert.deepEqual(byTitle(await list({ status: "Done" })), ["finished"]);
    assert.deepEqual(byTitle(await list({ status: "canceled" })), ["dropped"]);
    assert.deepEqual(byTitle(await list({ status: "in_progress" })), ["high mine"]);
    assert.equal((await list({ status: "Todo" })).counts.total, 7);
    await assert.rejects(list({ status: "nope" }), (e: ServiceError) => e.code === "invalid");
  });

  test("assignee, cycle, project, label, text", async () => {
    assert.deepEqual(byTitle(await list({ assignee: "me" })), ["high mine"]);
    assert.deepEqual(byTitle(await list({ assignee: "Tess" })), ["high mine"]);
    assert.equal((await list({ assignee: "none" })).issues.length, 4);
    assert.deepEqual(byTitle(await list({ cycle: "current" })), ["high mine"]);
    assert.deepEqual(byTitle(await list({ cycle: 1 })), ["high mine"]);
    assert.equal((await list({ cycle: "none" })).issues.length, 4);
    assert.deepEqual(byTitle(await list({ project: "Apollo" })), ["medium review"]);
    assert.deepEqual(byTitle(await list({ label: "BUG" })), ["urgent todo"]);
    assert.deepEqual(byTitle(await list({ text: "BACKLOG" })), ["low backlog", "none backlog"]);
    assert.equal((await list({ assignee: "me" })).counts.total, 1);
  });

  test("priority exact or minimum; updated_since", async () => {
    assert.deepEqual(byTitle(await list({ priority: "low" })), ["low backlog"]);
    assert.deepEqual(byTitle(await list({ priority: ">=high" })), ["urgent todo", "high mine"]);
    await assert.rejects(list({ priority: "huge" }), (e: ServiceError) => e.code === "invalid");
    assert.equal((await list({ updated_since: day(-1) })).issues.length, 5);
    assert.equal((await list({ updated_since: day(1) })).issues.length, 0);
    await assert.rejects(list({ updated_since: "soon" }), (e: ServiceError) => e.code === "invalid");
  });

  test("`more` counts what `limit` cut, with a hint; none left means 0 and no hint", async () => {
    const cut = await list({ limit: 2 });
    assert.equal(cut.issues.length, 2);
    assert.equal(cut.more, 3);
    assert.match(cut.hint, /3 more.*Narrow/);
    const all = await list();
    assert.equal(all.more, 0);
    assert.ok(!("hint" in all));
    assert.deepEqual(rows(cut), rows(all).slice(0, 2));
  });
});
