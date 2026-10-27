import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asKey, openSse, v1ok } from "./lib/http";
import { anon, app, newAccount, type Sess } from "./lib/app";

/**
 * The board and issue endpoints behind the team page and the issue dialog (WH-96): reads, create, edit with the version
 * check, move by id, name or role, comment, link, delete, the Bots menu's queue, and the rules that keep one workspace out of another's
 * issues. Everything that changes data does it in a workspace made for the test.
 */
const upsertNode = async (key: string, node: Record<string, unknown>) => (await v1ok({ key }, "update_map", { team: "RKT", changes: [{ op: "upsert_node", ...node }] })).results[0];
const SID = "00000000-0000-4000-8000-000000000000";

/** A workspace with one team, an API key for its agents, and the sessions to act as its owner. */
async function workspace(teamName = "Rocket") {
  const owner = await newAccount();
  const team = (await app("POST", "/api/app/teams", owner.sess, { body: { name: teamName, key: "RKT" } })).json.team;
  const key = (await app("POST", "/api/app/keys", owner.sess, { body: { name: "agent" } })).json.secret as string;
  return { owner, key, team, s: owner.sess };
}

const board = async (s: Sess, key = "RKT") => (await app("GET", `/api/app/teams/${key}/board`, s)).json;
const make = async (s: Sess, body: Record<string, unknown>, key = "RKT") => {
  const r = await app("POST", `/api/app/teams/${key}/issues`, s, { body });
  assert.equal(r.status, 201, r.text);
  return r.json.issue;
};
const order = (b: { issues: { statusId: string; position: number; ref: string }[] }, statusId: string) =>
  b.issues.filter((t) => t.statusId === statusId).sort((x, y) => x.position - y.position).map((t) => t.ref);

describe("every endpoint needs a signed-in person, and refuses a forged request", () => {
  const table: [string, string, unknown?][] = [
    ["GET", "/api/app/teams/RKT/board"],
    ["POST", "/api/app/teams/RKT/issues", { title: "x" }],
    ["GET", "/api/app/teams/RKT/queue"],
    ["GET", "/api/app/issues/RKT-1"],
    ["PATCH", "/api/app/issues/RKT-1", { title: "x" }],
    ["POST", "/api/app/issues/RKT-1/move", { status: "Done" }],
    ["DELETE", "/api/app/issues/RKT-1"],
    ["POST", "/api/app/issues/RKT-1/comments", { body: "x" }],
    ["PUT", `/api/app/issues/RKT-1/nodes/${SID}`],
    ["DELETE", `/api/app/issues/RKT-1/nodes/${SID}`],
  ];
  for (const [method, path, body] of table) {
    test(`${method} ${path}: 401 as JSON when signed out`, async () => {
      const r = await app(method, path, anon(), { body });
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, "unauthorized");
    });
  }

  test("a forged request (another site, no token, a wrong token) changes nothing", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Keep me" });
    for (const f of [{ origin: "https://evil.example" }, { csrf: null }, { csrf: "wrong" }]) {
      for (const [method, path, body] of [
        ["POST", "/api/app/teams/RKT/issues", { title: "Forged" }],
        ["PATCH", `/api/app/issues/${tk.ref}`, { title: "Forged" }],
        ["POST", `/api/app/issues/${tk.ref}/move`, { status: "Done" }],
        ["POST", `/api/app/issues/${tk.ref}/comments`, { body: "Forged" }],
        ["DELETE", `/api/app/issues/${tk.ref}`, undefined],
      ] as const) {
        const r = await app(method, path, t.s, { ...f, body });
        assert.equal(r.status, 403, `${method} ${path} ${JSON.stringify(f)}`);
        assert.equal(r.json.error.code, "csrf_failed");
      }
    }
    const b = await board(t.s);
    assert.deepEqual(b.issues.map((x: { title: string }) => x.title), ["Keep me"]);
    assert.equal(b.issues[0].commentCount, 0);
  });
});

describe("GET /api/app/teams/:key/board", () => {
  test("the team, its six statuses with their roles, issues, map nodes, members and the checklist", async () => {
    const t = await workspace();
    const b = await board(t.s);
    assert.deepEqual(Object.keys(b).sort(), ["checklist", "cycles", "issues", "members", "nodes", "projects", "statuses", "team"]);
    assert.deepEqual(Object.keys(b.team).sort(), ["description", "id", "key", "name"]);
    assert.deepEqual(b.statuses.map((c: { name: string; role: string }) => [c.name, c.role]), [["Backlog", "backlog"], ["Todo", "todo"], ["In Progress", "in_progress"], ["Review", "review"], ["Done", "done"], ["Canceled", "canceled"]]);
    assert.deepEqual(Object.keys(b.statuses[0]).sort(), ["color", "id", "isDefault", "name", "position", "role"]);
    assert.ok(b.statuses.every((c: { isDefault: boolean }) => c.isDefault), "a new team's statuses are each their role's default");
    assert.deepEqual(b.issues, []);
    assert.deepEqual(b.nodes, []);
    assert.deepEqual(b.members, [{ id: t.owner.me.user.id, name: "Owner" }]);
    assert.equal(b.checklist.total, 5);
    assert.deepEqual(Object.keys(b.checklist.items[0]).sort(), ["done", "href", "id", "label", "status"]);
  });

  test("an issue carries what a card shows, its linked nodes and comment count, and nothing internal", async () => {
    const t = await workspace();
    const node = await upsertNode(t.key, { layer: "concept", kind: "capability", name: "Billing", summary: "Takes money" });
    const tk = await make(t.s, { title: "Card", priority: "high", labels: ["bug"], body: "Why" });
    await app("PUT", `/api/app/issues/${tk.ref}/nodes/${node.id}`, t.s);
    await app("POST", `/api/app/issues/${tk.ref}/comments`, t.s, { body: { body: "hello" } });
    const b = await board(t.s);
    assert.deepEqual(Object.keys(b.issues[0]).sort(), ["agentClaimable", "assigneeId", "body", "claimedByKeyId", "commentCount", "createdAt", "createdByKind", "cycle", "id", "labels", "milestoneId", "nodeIds", "number", "parentId", "position", "priority", "projectId", "ref", "statusId", "title", "updatedAt", "version"]);
    assert.equal(b.issues[0].ref, "RKT-1");
    assert.deepEqual(b.issues[0].nodeIds, [node.id]);
    assert.equal(b.issues[0].commentCount, 1);
    assert.deepEqual(Object.keys(b.nodes[0]).sort(), ["id", "kind", "layer", "name", "parentId"]);
    assert.ok(!/teamId|createdById|workspaceId/.test(JSON.stringify(b.issues)), "no internal ids");
  });

  test("members are this workspace's people only", async () => {
    const a = await workspace();
    const other = await newAccount("Other");
    const members = (await board(a.s)).members.map((m: { id: string }) => m.id);
    assert.ok(members.includes(a.owner.me.user.id));
    assert.ok(!members.includes(other.me.user.id));
  });

  test("another workspace's team is a 404, whatever the case of its key", async () => {
    const a = await workspace();
    const other = await newAccount("Other");
    for (const key of ["RKT", "rkt"]) {
      const r = await app("GET", `/api/app/teams/${key}/board`, other.sess);
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, "not_found");
    }
    assert.equal((await app("GET", "/api/app/teams/rkt/board", a.s)).status, 200);
  });
});

describe("POST /api/app/teams/:key/issues", () => {
  test("creates in the first status by default: 201, version 1, a ref from the team", async () => {
    const t = await workspace();
    const r = await app("POST", "/api/app/teams/RKT/issues", t.s, { body: { title: "  First one  " } });
    assert.equal(r.status, 201);
    const tk = r.json.issue;
    assert.equal(tk.title, "First one");
    assert.equal(tk.ref, "RKT-1");
    assert.equal(tk.version, 1);
    assert.equal(tk.status, "Backlog");
    assert.equal(tk.priority, "none", "a new issue has no priority until it is given one");
    assert.equal(tk.createdByKind, "human");
    assert.equal(tk.agentClaimable, false, "a person's issue is not agent-claimable until they say so");
    assert.equal(tk.claimedByKeyId, null);
    assert.equal((await make(t.s, { title: "Second" })).ref, "RKT-2");
  });

  test("the status can be an id, a name, or a role", async () => {
    const t = await workspace();
    const cols = (await board(t.s)).statuses;
    const byId = await make(t.s, { title: "by id", status: cols[1].id });
    const byName = await make(t.s, { title: "by name", status: "In Progress" });
    const byRole = await make(t.s, { title: "by role", status: "review" });
    assert.deepEqual([byId.status, byName.status, byRole.status], ["Todo", "In Progress", "Review"]);
  });

  test("it takes priority, labels, body, assignee and the AI flag", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Full", body: "Markdown **body**", priority: "urgent", labels: ["a", "b"], assigneeId: t.owner.me.user.id, agentClaimable: true });
    assert.deepEqual([tk.body, tk.priority, tk.labels, tk.assigneeId, tk.agentClaimable], ["Markdown **body**", "urgent", ["a", "b"], t.owner.me.user.id, true]);
  });

  test("problems name the field: no title, the wrong type, an unknown priority or status", async () => {
    const t = await workspace();
    const cases: [Record<string, unknown>, string][] = [
      [{}, "title"],
      [{ title: "   " }, "title"],
      [{ title: 5 }, "title"],
      [{ title: "x", body: 5 }, "body"],
      [{ title: "x", priority: "critical" }, "priority"],
      [{ title: "x", labels: "bug" }, "labels"],
      [{ title: "x", labels: ["ok", 3] }, "labels"],
      [{ title: "x", agentClaimable: "yes" }, "agentClaimable"],
      [{ title: "x", assigneeId: 7 }, "assigneeId"],
      [{ title: "x", status: 7 }, "status"],
    ];
    for (const [body, field] of cases) {
      const r = await app("POST", "/api/app/teams/RKT/issues", t.s, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, "invalid");
      assert.ok(r.json.error.details.fields[field], `${JSON.stringify(body)} names ${field}`);
    }
    const col = await app("POST", "/api/app/teams/RKT/issues", t.s, { body: { title: "x", status: "Nowhere" } });
    assert.equal(col.status, 400);
    assert.match(col.json.error.message, /^Unknown status "Nowhere"\. Valid: Backlog, Todo/);
    assert.deepEqual((await board(t.s)).issues, [], "nothing was created");
  });

  test("an assignee from another workspace is refused, and so is a made-up one", async () => {
    const t = await workspace();
    const other = await newAccount("Other");
    for (const assigneeId of [other.me.user.id, SID, "not-an-id"]) {
      const r = await app("POST", "/api/app/teams/RKT/issues", t.s, { body: { title: "x", assigneeId } });
      assert.equal(r.status, 400, assigneeId);
      assert.equal(r.json.error.message, "Assignee must be a member of this team");
    }
  });

  test("another workspace's team is a 404 and gets no issue", async () => {
    const t = await workspace();
    const other = await newAccount("Other");
    const r = await app("POST", "/api/app/teams/RKT/issues", other.sess, { body: { title: "Intruder" } });
    assert.equal(r.status, 404);
    assert.deepEqual((await board(t.s)).issues, []);
  });
});

describe("GET /api/app/issues/:ref", () => {
  test("the issue, its discussion, linked nodes, history and pull requests", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Detail" });
    await app("POST", `/api/app/issues/${tk.ref}/comments`, t.s, { body: { body: "first" } });
    await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { priority: "high" } });
    const r = await app("GET", `/api/app/issues/${tk.ref}`, t.s);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ["children", "comments", "history", "issue", "nodes", "parent", "pullRequests", "team"]);
    assert.equal(r.json.issue.ref, "RKT-1");
    assert.equal(r.json.issue.status, "Backlog");
    assert.deepEqual(r.json.team, { key: "RKT", name: "Rocket" });
    assert.deepEqual(r.json.comments.map((c: { body: string }) => c.body), ["first"]);
    assert.deepEqual(Object.keys(r.json.comments[0]).sort(), ["authorKind", "authorName", "body", "createdAt", "id"]);
    assert.deepEqual(r.json.history.map((h: { summary: string }) => h.summary.split(" ")[0]), ["updated", "commented", "created"], "newest first");
    assert.deepEqual(Object.keys(r.json.history[0]).sort(), ["actorKind", "actorName", "createdAt", "seq", "summary"]);
    assert.deepEqual(r.json.pullRequests, []);
  });

  test("a ref is case-insensitive in its key, a made-up one is 404, a malformed one is 400", async () => {
    const t = await workspace();
    await make(t.s, { title: "x" });
    assert.equal((await app("GET", "/api/app/issues/rkt-1", t.s)).status, 200);
    assert.equal((await app("GET", "/api/app/issues/RKT-99", t.s)).status, 404);
    const bad = await app("GET", "/api/app/issues/nonsense", t.s);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "invalid");
  });
});

describe("PATCH /api/app/issues/:ref: the version check", () => {
  test("a change bumps the version; changing nothing does not", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "v" });
    const a = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { title: "v2", priority: "low", version: 1 } });
    assert.equal(a.status, 200);
    assert.deepEqual([a.json.issue.title, a.json.issue.priority, a.json.issue.version], ["v2", "low", 2]);
    const same = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { title: "v2", version: 2 } });
    assert.equal(same.json.issue.version, 2, "an edit that changes nothing is not a new version");
    assert.equal((await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: {} })).json.issue.version, 2);
  });

  test("a stale version is a 409 with the issue as it is now, and nothing is overwritten", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Original", body: "mine" });
    await v1ok({ key: t.key }, "update_issue", { ref: tk.ref, title: "Changed by an agent", expected_version: 1 });
    const stale = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { body: "my slow edit", version: 1 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "conflict");
    assert.match(stale.json.error.message, /^RKT-1 was changed \(version 2, you had 1\)/);
    const current = stale.json.error.details.current;
    assert.equal(current.title, "Changed by an agent");
    assert.equal(current.version, 2);
    assert.equal(current.ref, "RKT-1");
    assert.deepEqual(Object.keys(current).sort(), Object.keys(tk).filter((k) => k !== "status").sort(), "the same trimmed issue every answer uses");
    assert.ok(!/teamId|createdById/.test(JSON.stringify(stale.json)), "no raw row in an error");
    const after = (await app("GET", `/api/app/issues/${tk.ref}`, t.s)).json.issue;
    assert.deepEqual([after.title, after.body, after.version], ["Changed by an agent", "mine", 2], "the slow edit was not applied");
    const retry = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { body: "my slow edit", version: current.version } });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.issue.body, "my slow edit");
  });

  test("two edits from the same version: exactly one wins", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Race" });
    const [x, y] = await Promise.all(["x", "y"].map((p) => app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { title: `by ${p}`, version: 1 } })));
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  });

  test("without a version the change is applied over whatever is there (as the agents' tools do)", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Open" });
    await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { title: "one" } });
    const r = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { title: "two" } });
    assert.deepEqual([r.status, r.json.issue.title, r.json.issue.version], [200, "two", 3]);
  });

  test("every field can be set, and a wrong type names the field and changes nothing", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Fields" });
    const ok = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { title: "T", body: "B", priority: "urgent", labels: ["x"], agentClaimable: true, assigneeId: t.owner.me.user.id, version: 1 } });
    assert.deepEqual([ok.json.issue.title, ok.json.issue.body, ok.json.issue.priority, ok.json.issue.labels, ok.json.issue.agentClaimable, ok.json.issue.assigneeId], ["T", "B", "urgent", ["x"], true, t.owner.me.user.id]);
    const cleared = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { assigneeId: null } });
    assert.equal(cleared.json.issue.assigneeId, null);
    for (const [body, field] of [[{ title: "" }, "title"], [{ priority: "x" }, "priority"], [{ labels: [1] }, "labels"], [{ agentClaimable: 1 }, "agentClaimable"], [{ version: "1" }, "version"], [{ version: 1.5 }, "version"]] as const) {
      const r = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field], field);
    }
    assert.equal((await app("GET", `/api/app/issues/${tk.ref}`, t.s)).json.issue.title, "T");
  });

  test("an assignee from another workspace is refused", async () => {
    const t = await workspace();
    const other = await newAccount("Other");
    const tk = await make(t.s, { title: "x" });
    const r = await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { assigneeId: other.me.user.id } });
    assert.equal(r.status, 400);
    assert.equal((await app("GET", `/api/app/issues/${tk.ref}`, t.s)).json.issue.assigneeId, null);
  });
});

describe("POST /api/app/issues/:ref/move", () => {
  test("by status id, by name and by role; the issue changes status and its version goes up", async () => {
    const t = await workspace();
    const cols = (await board(t.s)).statuses;
    const tk = await make(t.s, { title: "Mover" });
    const byId = await app("POST", `/api/app/issues/${tk.ref}/move`, t.s, { body: { status: cols[1].id } });
    assert.deepEqual([byId.status, byId.json.issue.status, byId.json.issue.statusId, byId.json.issue.version], [200, "Todo", cols[1].id, 2]);
    assert.equal((await app("POST", `/api/app/issues/${tk.ref}/move`, t.s, { body: { status: "In Progress" } })).json.issue.status, "In Progress");
    assert.equal((await app("POST", `/api/app/issues/${tk.ref}/move`, t.s, { body: { status: "review" } })).json.issue.status, "Review");
    assert.equal((await app("POST", `/api/app/issues/${tk.ref}/move`, t.s, { body: { status: "done" } })).json.issue.statusId, cols[4].id);
  });

  test("index puts it in a place: first, in the middle, and the end when absent", async () => {
    const t = await workspace();
    const cols = (await board(t.s)).statuses;
    const [a, b, c] = [await make(t.s, { title: "a", status: "Todo" }), await make(t.s, { title: "b", status: "Todo" }), await make(t.s, { title: "c", status: "Todo" })];
    const d = await make(t.s, { title: "d" });
    await app("POST", `/api/app/issues/${d.ref}/move`, t.s, { body: { status: "Todo", index: 0 } });
    assert.deepEqual(order(await board(t.s), cols[1].id), [d.ref, a.ref, b.ref, c.ref]);
    await app("POST", `/api/app/issues/${c.ref}/move`, t.s, { body: { status: "Todo", index: 1 } });
    assert.deepEqual(order(await board(t.s), cols[1].id), [d.ref, c.ref, a.ref, b.ref]);
    await app("POST", `/api/app/issues/${d.ref}/move`, t.s, { body: { status: "Todo" } });
    assert.deepEqual(order(await board(t.s), cols[1].id), [c.ref, a.ref, b.ref, d.ref]);
  });

  test("into an empty status", async () => {
    const t = await workspace();
    const cols = (await board(t.s)).statuses;
    const tk = await make(t.s, { title: "Lonely" });
    const r = await app("POST", `/api/app/issues/${tk.ref}/move`, t.s, { body: { status: cols[3].id, index: 0 } });
    assert.equal(r.status, 200);
    assert.deepEqual(order(await board(t.s), cols[3].id), [tk.ref]);
    assert.deepEqual(order(await board(t.s), cols[0].id), []);
  });

  test("a stale version is a 409 with the current issue, and the issue does not move", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Stale" });
    await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { priority: "high" } });
    const r = await app("POST", `/api/app/issues/${tk.ref}/move`, t.s, { body: { status: "Done", version: 1 } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.details.current.version, 2);
    assert.equal((await app("GET", `/api/app/issues/${tk.ref}`, t.s)).json.issue.status, "Backlog");
  });

  test("problems: no status, an unknown one, a status that is not text, an index that is not a whole number", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Bad" });
    const go = (body: unknown) => app("POST", `/api/app/issues/${tk.ref}/move`, t.s, { body });
    assert.equal((await go({})).json.error.details.fields.status, "status is required");
    assert.equal((await go({ status: "Nowhere" })).status, 400);
    assert.ok((await go({ status: 3 })).json.error.details.fields.status);
    assert.ok((await go({ status: "Done", index: "0" })).json.error.details.fields.index);
    assert.ok((await go({ status: "Done", index: 0.5 })).json.error.details.fields.index);
    assert.equal((await app("GET", `/api/app/issues/${tk.ref}`, t.s)).json.issue.status, "Backlog");
  });

  test("the move is an event agents see, through the same write path (the agents' board shows it)", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Shared" });
    await app("POST", `/api/app/issues/${tk.ref}/move`, t.s, { body: { status: "review" } });
    const agentsBoard = await v1ok({ key: t.key }, "list_issues", { team: "RKT" });
    const inReview = agentsBoard.statuses.find((c: { name: string }) => c.name === "Review");
    assert.deepEqual(inReview.issues.map((x: { ref: string }) => x.ref), [tk.ref]);
  });
});

describe("DELETE /api/app/issues/:ref", () => {
  test("removes the issue and its comments; asking again is a 404", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Doomed" });
    await app("POST", `/api/app/issues/${tk.ref}/comments`, t.s, { body: "bye" });
    assert.deepEqual((await app("DELETE", `/api/app/issues/${tk.ref}`, t.s)).json, { ok: true });
    assert.equal((await app("GET", `/api/app/issues/${tk.ref}`, t.s)).status, 404);
    assert.equal((await app("DELETE", `/api/app/issues/${tk.ref}`, t.s)).status, 404);
    assert.deepEqual((await board(t.s)).issues, []);
  });
});

describe("comments", () => {
  test("a comment is 201, trimmed, by the person, and counted on the board", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Talk" });
    const r = await app("POST", `/api/app/issues/${tk.ref}/comments`, t.s, { body: { body: "  Looks **good**  " } });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json.comment).sort(), ["authorKind", "authorName", "body", "createdAt", "id"]);
    assert.deepEqual([r.json.comment.body, r.json.comment.authorKind, r.json.comment.authorName], ["Looks **good**", "human", "Owner"]);
    assert.equal((await board(t.s)).issues[0].commentCount, 1);
  });

  test("an empty or non-text comment is a 400 and adds nothing", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Talk" });
    for (const body of [{}, { body: "   " }, { body: 5 }, { body: null }]) {
      const r = await app("POST", `/api/app/issues/${tk.ref}/comments`, t.s, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, "invalid");
    }
    assert.equal((await board(t.s)).issues[0].commentCount, 0);
  });
});

describe("linking an issue to a map node", () => {
  test("link, link again (no harm), unlink; the board and the issue both show it", async () => {
    const t = await workspace();
    const node = await upsertNode(t.key, { layer: "system", kind: "service", name: "API", summary: "The API" });
    const tk = await make(t.s, { title: "Linked" });
    const url = `/api/app/issues/${tk.ref}/nodes/${node.id}`;
    assert.deepEqual((await app("PUT", url, t.s)).json, { ok: true });
    assert.deepEqual((await app("PUT", url, t.s)).json, { ok: true });
    assert.deepEqual((await board(t.s)).issues[0].nodeIds, [node.id]);
    const detail = (await app("GET", `/api/app/issues/${tk.ref}`, t.s)).json;
    assert.deepEqual(detail.nodes.map((n: { id: string }) => n.id), [node.id]);
    assert.deepEqual((await app("DELETE", url, t.s)).json, { ok: true });
    assert.deepEqual((await board(t.s)).issues[0].nodeIds, []);
  });

  test("a node of another workspace or team is a 404, and nothing is linked", async () => {
    const t = await workspace();
    const other = await workspace("Other");
    const foreign = await upsertNode(other.key, { layer: "system", kind: "service", name: "Foreign", summary: "x" });
    const tk = await make(t.s, { title: "Mine" });
    const r = await app("PUT", `/api/app/issues/${tk.ref}/nodes/${foreign.id}`, t.s);
    assert.equal(r.status, 404);
    assert.deepEqual((await board(t.s)).issues[0].nodeIds, []);
  });
});

describe("another workspace's issues are out of reach", () => {
  test("every read and write on an issue of another workspace is a 404, and the issue is untouched", async () => {
    const a = await workspace();
    const b = await newAccount("Intruder");
    const node = await upsertNode(a.key, { layer: "system", kind: "service", name: "N", summary: "x" });
    const tk = await make(a.s, { title: "Private", body: "secret plan" });
    const attempts: [string, string, unknown?][] = [
      ["GET", `/api/app/issues/${tk.ref}`],
      ["PATCH", `/api/app/issues/${tk.ref}`, { title: "Hacked", version: 1 }],
      ["POST", `/api/app/issues/${tk.ref}/move`, { status: "Done" }],
      ["POST", `/api/app/issues/${tk.ref}/comments`, { body: "hi" }],
      ["PUT", `/api/app/issues/${tk.ref}/nodes/${node.id}`],
      ["DELETE", `/api/app/issues/${tk.ref}/nodes/${node.id}`],
      ["DELETE", `/api/app/issues/${tk.ref}`],
      ["GET", "/api/app/teams/RKT/queue"],
      ["GET", "/api/app/teams/RKT/board"],
    ];
    for (const [method, path, body] of attempts) {
      const r = await app(method, path, b.sess, { body });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.ok(!r.text.includes("secret plan") && !r.text.includes("Private"), "nothing of the issue in the answer");
    }
    const mine = (await app("GET", `/api/app/issues/${tk.ref}`, a.s)).json;
    assert.deepEqual([mine.issue.title, mine.issue.body, mine.issue.version, mine.issue.status], ["Private", "secret plan", 1, "Backlog"]);
    assert.deepEqual(mine.comments, []);
  });

  test("an issue ref is only ever resolved inside the caller's own workspace, even when both workspaces have the same key", async () => {
    const a = await workspace();
    const b = await workspace();
    await make(a.s, { title: "A's first" });
    await make(b.s, { title: "B's first" });
    assert.equal((await app("GET", "/api/app/issues/RKT-1", a.s)).json.issue.title, "A's first");
    assert.equal((await app("GET", "/api/app/issues/RKT-1", b.s)).json.issue.title, "B's first");
  });
});

describe("the Bots menu's queue", () => {
  test("each agent key with its queue depth and sessions", async () => {
    const t = await workspace();
    const r = await app("GET", "/api/app/teams/RKT/queue", t.s);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ["bots"]);
    assert.equal(r.json.bots.length, 1);
    assert.deepEqual(Object.keys(r.json.bots[0]).sort(), ["id", "lastUsedAt", "name", "pending", "sessions"]);
    assert.equal(r.json.bots[0].name, "agent");
    assert.equal(r.json.bots[0].pending, 0);
    assert.deepEqual(r.json.bots[0].sessions, []);
  });

  test("a change by another actor shows up as queued for an agent, and mark-all-seen for the team clears it", async () => {
    const t = await workspace();
    await v1ok({ key: t.key }, "get_changes", { team: "RKT" });
    await make(t.s, { title: "Queued for the agent" });
    const before = (await app("GET", "/api/app/teams/RKT/queue", t.s)).json.bots[0];
    assert.ok(before.pending >= 1, `pending ${before.pending}`);
    await app("POST", "/api/app/keys/mark-all-seen", t.s, { body: { keyId: before.id, teamKey: "RKT" } });
    assert.equal((await app("GET", "/api/app/teams/RKT/queue", t.s)).json.bots[0].pending, 0);
  });
});

describe("a change by an agent reaches an open board within a second", () => {
  test("the team's stream announces it", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Watched" });
    const stream = await openSse("/api/teams/RKT/stream", { cookie: t.s.cookie });
    try {
      assert.equal(stream.status, 200);
      await stream.waitFor((e) => e.event === "ready");
      const started = Date.now();
      await v1ok({ key: t.key }, "update_issue", { ref: tk.ref, status: "Review" });
      const change = await stream.waitFor((e) => e.event === "change" && /moved RKT-1/.test(String(e.data?.summary)), 1000);
      assert.ok(Date.now() - started < 1000, "within a second");
      assert.match(String(change.data.summary), /Backlog → Review/);
    } finally {
      stream.close();
    }
  });

  test("and the person's own change through the web API is announced the same way", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "Mine" });
    const stream = await openSse("/api/teams/RKT/stream", { cookie: t.s.cookie });
    try {
      await stream.waitFor((e) => e.event === "ready");
      await app("POST", `/api/app/issues/${tk.ref}/comments`, t.s, { body: { body: "ping" } });
      await stream.waitFor((e) => e.event === "change" && /commented on RKT-1/.test(String(e.data?.summary)), 1000);
    } finally {
      stream.close();
    }
  });
});

describe("claim state", () => {
  test("a person lets agents pick an issue up; an agent claims it; the board and the dialog show it", async () => {
    const t = await workspace();
    const tk = await make(t.s, { title: "For agents" });
    assert.equal((await app("PATCH", `/api/app/issues/${tk.ref}`, t.s, { body: { agentClaimable: true } })).json.issue.agentClaimable, true);
    await v1ok({ key: t.key }, "update_issue", { ref: tk.ref, assignee: "me" });
    const onBoard = (await board(t.s)).issues[0];
    assert.equal(onBoard.agentClaimable, true);
    assert.ok(onBoard.claimedByKeyId, "claimed by an agent key");
    assert.equal((await app("GET", `/api/app/issues/${tk.ref}`, t.s)).json.issue.claimedByKeyId, onBoard.claimedByKeyId);
  });
});

describe("sub-issues over the web API", () => {
  test("an issue is created under another and shows on both: the card has parentId, the dialog has parent and children", async () => {
    const t = await workspace();
    const parent = await make(t.s, { title: "Parent" });
    assert.equal(parent.parentId, null);
    const child = await make(t.s, { title: "Child", parent: parent.ref });
    assert.equal(child.parentId, parent.id);
    assert.equal((await board(t.s)).issues.find((x: { ref: string }) => x.ref === child.ref).parentId, parent.id);
    const p = (await app("GET", `/api/app/issues/${parent.ref}`, t.s)).json;
    assert.deepEqual(p.children, [{ ref: child.ref, title: "Child", priority: "none", status: "Backlog", done: false, canceled: false, assigneeId: null }]);
    assert.equal(p.parent, null);
    assert.equal((await app("GET", `/api/app/issues/${child.ref}`, t.s)).json.parent.ref, parent.ref);
  });

  test("PATCH moves an issue under another and out again, and refuses a loop with a 400 that names the field's problem", async () => {
    const t = await workspace();
    const a = await make(t.s, { title: "A" });
    const b = await make(t.s, { title: "B" });
    const c = await make(t.s, { title: "C", parent: b.ref });
    const moved = await app("PATCH", `/api/app/issues/${b.ref}`, t.s, { body: { parent: a.ref } });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.json.issue.parentId, a.id);
    const loop = await app("PATCH", `/api/app/issues/${a.ref}`, t.s, { body: { parent: c.ref } });
    assert.equal(loop.status, 400);
    assert.match(loop.json.error.message, /cannot be the parent/);
    assert.equal((await app("GET", `/api/app/issues/${a.ref}`, t.s)).json.issue.parentId, null, "the refused change left it as it was");
    const freed = await app("PATCH", `/api/app/issues/${b.ref}`, t.s, { body: { parent: null } });
    assert.equal(freed.json.issue.parentId, null);
  });

  test("a parent must be an issue ref (or null): a wrong type names the field, a made-up or another team's issue is refused", async () => {
    const t = await workspace();
    const other = (await app("POST", "/api/app/teams", t.s, { body: { name: "Other", key: "OTH" } })).json.team;
    const foreign = await make(t.s, { title: "Elsewhere" }, other.key);
    const mine = await make(t.s, { title: "Mine" });
    for (const parent of [3, "", {}, []]) {
      const r = await app("PATCH", `/api/app/issues/${mine.ref}`, t.s, { body: { parent } });
      assert.equal(r.status, 400, JSON.stringify(parent));
      assert.deepEqual(Object.keys(r.json.error.details.fields), ["parent"]);
    }
    for (const parent of [foreign.ref, "RKT-9999"]) assert.equal((await app("PATCH", `/api/app/issues/${mine.ref}`, t.s, { body: { parent } })).status, 400, parent);
  });

  test("deleting a parent leaves its sub-issues, free", async () => {
    const t = await workspace();
    const parent = await make(t.s, { title: "Parent" });
    const child = await make(t.s, { title: "Child", parent: parent.ref });
    assert.equal((await app("DELETE", `/api/app/issues/${parent.ref}`, t.s)).status, 200);
    assert.equal((await app("GET", `/api/app/issues/${child.ref}`, t.s)).json.issue.parentId, null);
  });

  test("the agents' tools do the same: create_issue and update_issue take `parent`, get_issue shows the tree", async () => {
    const t = await workspace();
    const parent = await v1ok(asKey(t.key), "create_issue", { team: "RKT", title: "Epic" });
    const child = await v1ok(asKey(t.key), "create_issue", { team: "RKT", title: "Task", parent: parent.ref });
    const detail = await v1ok(asKey(t.key), "get_issue", { ref: parent.ref });
    assert.deepEqual(detail.children.map((c: { ref: string }) => c.ref), [child.ref]);
    assert.equal((await v1ok(asKey(t.key), "get_issue", { ref: child.ref })).parent.ref, parent.ref);
    const lone = await v1ok(asKey(t.key), "create_issue", { team: "RKT", title: "Lone" });
    await v1ok(asKey(t.key), "update_issue", { ref: lone.ref, parent: parent.ref });
    assert.equal((await v1ok(asKey(t.key), "get_issue", { ref: lone.ref })).parent.ref, parent.ref);
    await v1ok(asKey(t.key), "update_issue", { ref: lone.ref, parent: null });
    assert.equal((await v1ok(asKey(t.key), "get_issue", { ref: lone.ref })).parent, null);
  });
});

