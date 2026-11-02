import { describe, expect, test } from "vitest";
import type { JobView } from "@wheelhouse/api-client";
import { madeNoChanges, runStatus } from "./run-status";

const job = (state: JobView["state"], delivery: JobView["delivery"] = null, cancelRequested = false) => ({ state, delivery, cancelRequested });

describe("run status", () => {
  test("a pull request reads by its live state, and stays 'PR opened' until it is known", () => {
    const pr = (state: "open" | "closed" | "merged" | null) => ({ ...job("succeeded", "pr_opened"), pullRequest: { number: 1, url: "u", state, verdict: null } });
    expect(runStatus(pr("merged"))).toEqual({ label: "PR merged", tone: "good" });
    expect(runStatus(pr("closed"))).toEqual({ label: "PR closed", tone: "muted" });
    expect(runStatus(pr("open"))).toEqual({ label: "PR open", tone: "good" });
    expect(runStatus({ ...pr("open"), pullRequest: { state: "open" as const, verdict: { state: "red" as const, reasons: [] } } })).toEqual({ label: "checks failing", tone: "warn" });
    expect(runStatus(pr(null))).toEqual({ label: "PR opened", tone: "good" });
  });

  test("a clean run says what it left behind, never just 'done'", () => {
    expect(runStatus(job("succeeded", "pr_opened"))).toEqual({ label: "PR opened", tone: "good" });
    expect(runStatus(job("succeeded", "pushed"))).toEqual({ label: "pushed", tone: "good" });
    expect(runStatus(job("succeeded", "pr_failed"))).toEqual({ label: "no PR", tone: "warn" });
    expect(runStatus(job("succeeded", "none"))).toEqual({ label: "no changes", tone: "muted" });
  });

  test("a run that went wrong, was stopped or never started says so", () => {
    expect(runStatus(job("failed"))).toEqual({ label: "failed", tone: "bad" });
    expect(runStatus(job("failed", "pushed")).label).toBe("failed");
    expect(runStatus(job("canceled"))).toEqual({ label: "stopped", tone: "muted" });
    expect(runStatus(job("rejected")).label).toBe("refused");
    expect(runStatus(job("expired")).label).toBe("not picked up");
    expect(runStatus(job("lost")).tone).toBe("warn");
  });

  test("a run in progress shows where it is, and a stop in progress says stopping", () => {
    expect(runStatus(job("offered"))).toEqual({ label: "waiting for the device", tone: "active" });
    expect(runStatus(job("accepted")).label).toBe("setting up");
    expect(runStatus(job("running")).label).toBe("running");
    expect(runStatus(job("running", null, true)).label).toBe("stopping");
  });

  test("only a clean run that left nothing counts as having made no changes", () => {
    expect(madeNoChanges(job("succeeded", "none"))).toBe(true);
    expect(madeNoChanges(job("succeeded", "pushed"))).toBe(false);
    expect(madeNoChanges(job("failed", "none"))).toBe(false);
  });
});
