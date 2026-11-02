import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CiPolicy } from "../../db/tables/github";
import { DEFAULT_POLICY, verdictFor, worst, type VerdictInputs } from "./verdict.rules";

const done = (conclusion: string) => ({ status: "completed", conclusion });
const running = { status: "in_progress", conclusion: null };
const NONE: CiPolicy = { ...DEFAULT_POLICY, mode: "none" };
const pushedAt = new Date("2026-11-01T10:00:00Z");
const at = (minutes: number) => new Date(pushedAt.getTime() + minutes * 60_000);
const input = (over: Partial<VerdictInputs>): VerdictInputs => ({ policy: DEFAULT_POLICY, protectionRequired: [], selfChecks: null, checks: {}, pushedAt, now: at(1), ...over });
const lint = (status: string, required = true) => ({ name: "lint", required, status });

describe("verdictFor", () => {
  const rows: [string, Partial<VerdictInputs>, string, string[]][] = [
    ["a required self-check failed", { selfChecks: [lint("failed")], checks: { build: done("success") } }, "red", ["self-check lint failed"]],
    ["a required self-check could not run", { selfChecks: [lint("could_not_run")] }, "red", ["self-check lint could not run"]],
    ["an optional self-check failed, CI passed", { selfChecks: [lint("failed", false)], checks: { build: done("success") } }, "green", []],
    ["no CI, no self-checks", { policy: NONE }, "pending", ["no evidence"]],
    ["no CI, no self-checks, past the start timeout", { policy: NONE, now: at(11) }, "stalled", ["no evidence"]],
    ["no CI, self-checks passed", { policy: NONE, selfChecks: [lint("passed")] }, "green", []],
    ["CI, no self-checks: CI decides", { checks: { build: done("success") } }, "green", []],
    ["CI, self-checks passed, a job failed", { selfChecks: [lint("passed")], checks: { build: done("failure"), e2e: running } }, "red", ["CI job build failed"]],
    ["CI, a job still running", { checks: { build: done("success"), e2e: running } }, "pending", ["CI job e2e is still running"]],
    ["CI, skipped and neutral jobs pass", { checks: { build: done("skipped"), docs: done("neutral") } }, "green", []],
    ["CI, nothing reported yet", {}, "pending", ["no CI has reported"]],
    ["CI, nothing reported past the start timeout", { now: at(11) }, "stalled", ["no CI has reported"]],
    ["CI, a job running past the start timeout is not stalled", { checks: { build: running }, now: at(60) }, "pending", ["CI job build is still running"]],
    ["named checks, one not seen yet", { policy: { ...DEFAULT_POLICY, required: ["build", "e2e"] }, checks: { build: done("success") } }, "pending", ["CI job e2e has not reported"]],
    ["named checks, an unseen one is optionalIfAbsent", { policy: { ...DEFAULT_POLICY, required: ["build", "e2e"], optionalIfAbsent: ["e2e"] }, checks: { build: done("success") } }, "green", []],
    ["named checks, an unrequired job failing does not count", { policy: { ...DEFAULT_POLICY, required: ["build"] }, checks: { build: done("success"), flaky: done("failure") } }, "green", []],
    ["branch protection names the required checks", { policy: { ...DEFAULT_POLICY, required: "branch_protection" }, protectionRequired: ["build"], checks: { build: done("success"), flaky: done("failure") } }, "green", []],
    ["branch protection naming nothing counts every check", { policy: { ...DEFAULT_POLICY, required: "branch_protection" }, checks: { flaky: done("failure") } }, "red", ["CI job flaky failed"]],
  ];
  for (const [name, over, state, reasons] of rows) {
    test(name, () => assert.deepEqual(verdictFor(input(over)), { state, reasons }));
  }
});

describe("worst", () => {
  test("red beats stalled beats pending beats green, and every reason is kept", () => {
    assert.deepEqual(worst([{ state: "green", reasons: [] }, { state: "pending", reasons: ["a"] }]), { state: "pending", reasons: ["a"] });
    assert.deepEqual(worst([{ state: "pending", reasons: ["a"] }, { state: "stalled", reasons: ["b"] }, { state: "green", reasons: [] }]), { state: "stalled", reasons: ["a", "b"] });
    assert.deepEqual(worst([{ state: "stalled", reasons: ["b"] }, { state: "red", reasons: ["c"] }]), { state: "red", reasons: ["b", "c"] });
  });
});
