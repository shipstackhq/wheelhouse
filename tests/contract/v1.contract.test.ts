import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asKey, call, fx, unique, v1, v1ok } from "./lib/http";
import { expectGolden } from "./lib/golden";
import { shape } from "./lib/shape";

const A = asKey(fx.a.apiKey);
const A2 = asKey(fx.a.apiKey2);

describe("GET /api/v1", () => {
  test("lists every tool, including hidden ones, without credentials", async () => {
    const r = await call("/api/v1");
    assert.equal(r.status, 200);
    assert.match(r.json.usage, /POST \/api\/v1\/<name>/);
    const names = r.json.tools.map((t: { name: string }) => t.name).sort();
    assert.ok(names.length > 30);
    expectGolden("v1-tool-names", names);
  });
});

describe("POST /api/v1/:tool: errors", () => {
  test("no credentials: 401 unauthorized", async () => {
    const r = await v1({}, "list_projects");
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, "unauthorized");
  });

  test("a bad or revoked key is 401; a suspended workspace's key is 403 team_suspended", async () => {
    assert.equal((await v1(asKey("wh_bogus"), "list_projects")).status, 401);
    assert.equal((await v1(asKey(fx.a.revokedKey), "list_projects")).status, 401);
    const s = await v1(asKey(fx.suspended.apiKey), "list_projects");
    assert.equal(s.status, 403);
    assert.equal(s.json.error.code, "team_suspended");
  });

  test("unknown tool is 404 not_found; bad arguments are 400 invalid; both use the same envelope", async () => {
    const unknown = await v1(A, "no_such_tool");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, "not_found");
    const invalid = await v1(A, "update_ticket", {});
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, "invalid");
    assert.equal(typeof invalid.json.error.message, "string");
    // An unparseable body counts as no arguments.
    const garbage = await call("/api/v1/update_ticket", { ...A, method: "POST", rawBody: "{not json", headers: { "content-type": "application/json" } });
    assert.equal(garbage.status, 400);
    assert.equal(garbage.json.error.code, "invalid");
  });

  test("the response envelope is recorded", async () => {
    const err = await v1(A, "get_ticket", { ticket: "ZZZ-999" });
    assert.equal(err.status, 404);
    expectGolden("v1-error-envelope", shape(err.json));
  });
});

describe("POST /api/v1/:tool: tickets", () => {
  test("create, read, edit with optimistic locking, move by name and by role, comment, claim", async () => {
    const title = unique("v1 flow");
    const made = await v1ok(A, "create_ticket", { project: fx.a.projectKey, title, body: "body", priority: "high", labels: ["contract"] });
    assert.match(made.ref, new RegExp(`^${fx.a.projectKey}-\\d+$`));
    assert.equal(made.column, "Backlog");
    assert.equal(made.version, 1);

    const edited = await v1ok(A, "update_ticket", { ticket: made.ref, title: `${title} edited`, expected_version: 1 });
    assert.equal(edited.version, 2);
    const stale = await v1(A, "update_ticket", { ticket: made.ref, title: "lost update", expected_version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "conflict");
    assert.equal(stale.json.error.details.current.title, `${title} edited`, "a conflict carries the current state");

    assert.equal((await v1ok(A, "move_ticket", { ticket: made.ref, column: "In Progress" })).column, "In Progress");
    assert.equal((await v1ok(A, "move_ticket", { ticket: made.ref, column: "review" })).column, "Review", "a role finds the column (ADR-15)");
    assert.equal((await v1ok(A, "move_ticket", { ticket: made.ref, column: "done" })).column, "Done");
    const badColumn = await v1(A, "move_ticket", { ticket: made.ref, column: "Nowhere" });
    assert.equal(badColumn.status, 400);
    assert.match(badColumn.json.error.message, /Unknown column/);

    const c = await v1ok(A, "comment", { ticket: made.ref, body: "hello from the contract suite" });
    assert.equal(c.body, "hello from the contract suite");
    const got = await v1ok(A, "get_ticket", { ticket: made.ref });
    assert.equal(got.ticket.column, "Done");
    assert.equal(got.comments.length, 1);
    assert.ok(got.history.some((e: { type: string }) => e.type === "ticket.moved"));

    // Only one agent can hold a claim.
    const claimable = await v1ok(A, "create_ticket", { project: fx.a.projectKey, title: unique("claim me") });
    assert.equal((await v1ok(A, "claim_ticket", { ticket: claimable.ref })).claimedByKeyId.length > 0, true);
    const second = await v1(A2, "claim_ticket", { ticket: claimable.ref });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "conflict");
  });

  test("response shapes of the core tools are recorded", async () => {
    const created = await v1ok(A, "create_ticket", { project: fx.a.projectKey, title: unique("shape"), labels: ["x"] });
    const shapes = {
      list_projects: shape(await v1ok(A, "list_projects")),
      get_board: shape(await v1ok(A, "get_board", { project: fx.a.projectKey })),
      create_ticket: shape(created),
      get_ticket: shape(await v1ok(A, "get_ticket", { ticket: created.ref })),
      get_changes: shape(await v1ok(A, "get_changes", { project: fx.a.projectKey })),
      get_activity: shape(await v1ok(A, "get_activity", { project: fx.a.projectKey })),
    };
    expectGolden("v1-shapes", shapes);
  });

  test("a new project's board has the five workflow columns in order", async () => {
    const board = await v1ok(A, "get_board", { project: fx.a.projectKey });
    assert.deepEqual(
      board.columns.map((c: { name: string }) => c.name),
      ["Backlog", "Todo", "In Progress", "Review", "Done"],
    );
  });
});

describe("POST /api/v1/:tool: sessions (ADR-4, ADR-5)", () => {
  test("a call that names a session is attributed to it, and another key cannot take that session over", async () => {
    const session = unique("ct-session");
    const mine = await v1ok(A, "get_changes", { project: fx.a.projectKey, session });
    assert.equal(mine.session, session);
    const other = await v1(A2, "get_changes", { project: fx.a.projectKey, session });
    assert.equal(other.status, 403);
    assert.equal(other.json.error.code, "forbidden");
    assert.equal((await v1ok(A, "get_changes", { project: fx.a.projectKey })).session, null, "without a session the key-level queue is used");
  });

  test("each session has its own queue cursor; acking in one leaves the other's unread", async () => {
    const s1 = unique("ct-s1");
    const s2 = unique("ct-s2");
    // A teammate (a person's session cookie is not needed: a second key stands in) makes a change both sessions have not seen.
    await v1ok(A2, "create_ticket", { project: fx.a.projectKey, title: unique("queue") });
    const first = await v1ok(A, "get_changes", { project: fx.a.projectKey, session: s1 });
    const second = await v1ok(A, "get_changes", { project: fx.a.projectKey, session: s2 });
    assert.ok(first.latestSeq >= 1);
    await v1ok(A, "ack_changes", { project: fx.a.projectKey, session: s1, seq: first.latestSeq });
    assert.equal((await v1ok(A, "get_changes", { project: fx.a.projectKey, session: s1 })).total, 0);
    assert.equal((await v1ok(A, "get_changes", { project: fx.a.projectKey, session: s2 })).total, second.total);
  });
});
