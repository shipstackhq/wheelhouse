import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { statusField, intField, issueInput, delegationState, suggestAgent } from "./issues.rules";
import { ServiceError } from "../../common/service-error";

/** Reading a request body for the board and issue endpoints: nothing wrong-typed gets past here to the database. */
const fieldsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ServiceError && e.code === "invalid", `expected an invalid ServiceError, got ${String(e)}`);
    return Object.keys((e.details as { fields: Record<string, string> }).fields);
  }
  return assert.fail("expected an error");
};

describe("issueInput", () => {
  test("a new issue needs a title; the title is trimmed", () => {
    assert.deepEqual(issueInput({ title: "  Hello  " }, { create: true }), { title: "Hello" });
    assert.deepEqual(fieldsOf(() => issueInput({}, { create: true })), ["title"]);
    assert.deepEqual(fieldsOf(() => issueInput({ title: "   " }, { create: true })), ["title"]);
  });

  test("an edit carries only what was sent", () => {
    assert.deepEqual(issueInput({}, { create: false }), {});
    assert.deepEqual(issueInput({ priority: "high", labels: [] }, { create: false }), { priority: "high", labels: [] });
    assert.deepEqual(issueInput({ body: "" }, { create: false }), { body: "" }, "an empty body is a real change");
  });

  test("an assignee can be cleared with null or an empty string, and set with an id", () => {
    assert.deepEqual(issueInput({ assigneeId: null }, { create: false }), { assigneeId: null });
    assert.deepEqual(issueInput({ assigneeId: "" }, { create: false }), { assigneeId: null });
    assert.deepEqual(issueInput({ assigneeId: "abc" }, { create: false }), { assigneeId: "abc" });
  });

  test("every wrong type is a field error naming it", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ title: 1 }, "title"],
      [{ title: "" }, "title"],
      [{ body: 1 }, "body"],
      [{ body: null }, "body"],
      [{ priority: "critical" }, "priority"],
      [{ priority: 1 }, "priority"],
      [{ assigneeId: 1 }, "assigneeId"],
      [{ agentClaimable: "true" }, "agentClaimable"],
      [{ agentClaimable: 1 }, "agentClaimable"],
      [{ labels: "bug" }, "labels"],
      [{ labels: ["ok", 2] }, "labels"],
      [{ labels: [null] }, "labels"],
    ];
    for (const [body, field] of cases) assert.deepEqual(fieldsOf(() => issueInput(body, { create: false })), [field], JSON.stringify(body));
  });

  test("unknown fields are ignored, not passed on", () => {
    assert.deepEqual(issueInput({ title: "x", teamId: "other", version: 3, createdById: "z" }, { create: true }), { title: "x" });
  });
});

describe("intField and statusField", () => {
  test("a whole number, or absent", () => {
    assert.equal(intField({ n: 3 }, "n"), 3);
    assert.equal(intField({ n: 0 }, "n"), 0);
    assert.equal(intField({ n: -1 }, "n"), -1);
    assert.equal(intField({}, "n"), undefined);
    assert.equal(intField({ n: null }, "n"), undefined);
    for (const n of ["3", 1.5, NaN, Infinity, 2 ** 60, true, []]) assert.deepEqual(fieldsOf(() => intField({ n }, "n")), ["n"], String(n));
  });

  test("a status is text, and required where it must be", () => {
    assert.equal(statusField({ status: "Done" }, true), "Done");
    assert.equal(statusField({}, false), undefined);
    assert.deepEqual(fieldsOf(() => statusField({}, true)), ["status"]);
    for (const status of [3, "", "  ", {}, []]) assert.deepEqual(fieldsOf(() => statusField({ status }, true)), ["status"], JSON.stringify(status));
  });
});

describe("delegationState (WH-132)", () => {
  const run = (state: string, repositoryId: string | null = "a") => ({ repositoryId, state });
  test("no runs: needs setup without targets, waiting with them", () => {
    assert.equal(delegationState(false, []), "needs_setup");
    assert.equal(delegationState(true, []), "waiting");
  });
  test("a run still going wins; then a failure, a stop, and done", () => {
    assert.equal(delegationState(true, [run("running"), run("failed", "b")]), "running");
    assert.equal(delegationState(true, [run("failed"), run("succeeded", "b")]), "failed");
    assert.equal(delegationState(true, [run("canceled"), run("succeeded", "b")]), "stopped");
    assert.equal(delegationState(true, [run("succeeded"), run("succeeded", "b")]), "done");
  });
  test("a pull request moves a done delegation on: open is in review, merged is merged, closed stays done", () => {
    const pr = (prState: "open" | "closed" | "merged", repositoryId = "a") => ({ ...run("succeeded", repositoryId), prState });
    assert.equal(delegationState(true, [pr("open")]), "in_review");
    assert.equal(delegationState(true, [pr("merged"), pr("open", "b")]), "in_review");
    assert.equal(delegationState(true, [pr("merged")]), "merged");
    assert.equal(delegationState(true, [pr("closed")]), "done");
    assert.equal(delegationState(true, [pr("open"), run("failed", "b")]), "failed");
    assert.equal(delegationState(true, [{ ...pr("open"), verdict: "red" }]), "checks_failing");
    assert.equal(delegationState(true, [{ ...pr("open"), verdict: "pending" }]), "in_review");
  });
  test("only a target's latest run counts: a rerun that worked clears the failure", () => {
    assert.equal(delegationState(true, [run("succeeded"), run("failed")]), "done");
  });
});

describe("suggestAgent (WH-125)", () => {
  const agents = [
    { slug: "fe", name: "Frontend", role: "UI engineer", pathScope: ["apps/web/"] },
    { slug: "be", name: "Backend", role: "API engineer", pathScope: ["apps/api/"] },
  ];
  test("a label naming the agent wins, then the paths of its linked map nodes", () => {
    assert.equal(suggestAgent(agents, ["backend"], []), "be");
    assert.equal(suggestAgent(agents, ["UI"], []), "fe");
    assert.equal(suggestAgent(agents, [], ["apps/api/src/**", "apps/api/drizzle/**"]), "be");
    assert.equal(suggestAgent(agents, ["backend"], ["apps/web/src/**", "apps/web/public/**", "apps/web/index.html"]), "fe");
  });
  test("no match, or a tie, suggests nothing", () => {
    assert.equal(suggestAgent(agents, ["docs"], ["README.md"]), null);
    assert.equal(suggestAgent(agents, ["backend", "frontend"], []), null);
    assert.equal(suggestAgent([], ["backend"], []), null);
  });
});
