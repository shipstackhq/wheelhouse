import { describe, expect, test } from "vitest";
import type { JobView } from "@wheelhouse/api-client";
import { madeNoChanges, runStatusLabel } from "./run-status";

const job = (state: JobView["state"], result: JobView["result"] = {}, cancelRequested = false) => ({ state, result, cancelRequested });

describe("run status", () => {
  test("a clean run that pushed nothing says it changed nothing, not just done", () => {
    expect(runStatusLabel(job("succeeded", { pushed: false, diffStats: { files: 0, insertions: 0, deletions: 0 } }))).toBe("finished, no changes");
    expect(runStatusLabel(job("succeeded", { pushed: false }))).toBe("finished, no changes");
    expect(madeNoChanges(job("succeeded", { pushed: false }))).toBe(true);
  });

  test("a run that pushed, or has a pull request, is done", () => {
    expect(runStatusLabel(job("succeeded", { pushed: true, diffStats: { files: 2, insertions: 3, deletions: 0 } }))).toBe("done");
    expect(runStatusLabel(job("succeeded", { pushed: false, diffStats: { files: 1, insertions: 1, deletions: 0 } }))).toBe("done");
    expect(madeNoChanges(job("succeeded", { pushed: false, pullRequest: { number: 1, url: "u" } as never }))).toBe(false);
  });

  test("other outcomes keep their own words, and a stop in progress says stopping", () => {
    expect(runStatusLabel(job("failed"))).toBe("failed");
    expect(runStatusLabel(job("canceled"))).toBe("canceled");
    expect(runStatusLabel(job("running", {}, true))).toBe("stopping");
    expect(madeNoChanges(job("failed"))).toBe(false);
  });
});
