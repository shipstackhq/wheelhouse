import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IssueRuns, JobView } from "@wheelhouse/api-client";
import { apiError, renderIn, serverWithData } from "../../test/harness";
import { IssueRunsSection } from "./issue-runs";

const job = (id: string, over: Partial<JobView> = {}): JobView => ({
  id,
  state: "succeeded",
  model: "haiku",
  branch: `wh/WH-1-x-${id}`,
  baseBranch: "ui-changes",
  deviceId: "dev-1",
  deviceName: "Atharva's MacBook Pro",
  repositoryId: "repo-1",
  repositoryName: "wheelhouse",
  result: { pushed: true, diffStats: { files: 2, insertions: 13, deletions: 2 }, costUsd: 0.02 },
  delivery: "pushed",
  continuesJobId: null,
  error: null,
  cancelRequested: false,
  unreachableSince: null,
  lastHeardAt: null,
  markedLost: false,
  createdAt: new Date().toISOString(),
  acceptedAt: null,
  startedAt: null,
  finishedAt: null,
  ...over,
});

const runs = (jobs: JobView[]): IssueRuns => ({
  jobs,
  devices: [{ id: "dev-1", name: "Atharva's MacBook Pro", status: "online", models: ["haiku", "sonnet"], poolSize: 3, activeJobs: 0 }],
  repositories: [{ id: "repo-1", name: "wheelhouse", fullName: "shipstackhq/wheelhouse", defaultBranch: "staging" }],
});

function mount(jobs: JobView[], setup: (s: ReturnType<typeof serverWithData>) => void = () => {}) {
  const server = serverWithData();
  server.on("GET /api/app/issues/WH-1/jobs", runs(jobs));
  server.on("GET /api/app/issues/WH-1/jobs/branches", { defaultBranch: "staging", branches: ["staging", "ui-changes"], listed: true });
  setup(server);
  return renderIn(<IssueRunsSection issueRef="WH-1" />, "/", server);
}

describe("runs on a device", () => {
  test("each run's chip says what it left behind: a pull request, a push whose pull request was refused, or nothing", async () => {
    mount([
      job("a1", { delivery: "pr_opened", result: { pushed: true, pullRequest: { number: 7, url: "https://github.com/x/y/pull/7" } } }),
      job("b2", { delivery: "pr_failed", result: { pushed: true, pullRequestError: 'GitHub refused: the App needs the "Pull requests: Read and write" permission' } }),
      job("c3", { delivery: "none", result: { pushed: false } }),
      job("d4", { state: "failed", delivery: "none", error: "claude exited with 1" }),
    ]);
    const list = await screen.findByRole("list", { name: "Runs" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => within(li).getAllByText(/PR opened|no PR|no changes|failed/)[0].textContent)).toEqual(["PR opened", "no PR", "no changes", "failed"]);
    expect(within(items[1]).getByText(/GitHub refused/)).toBeTruthy();
    expect(screen.queryByText("done")).toBeNull();
  });

  test("Continue carries on from the run's branch; Start over makes a fresh run from the same starting branch", async () => {
    const { server } = mount([job("e5", { delivery: "pr_failed", result: { pushed: true, pullRequestError: "no" }, model: "sonnet", baseBranch: "ui-changes" })], (s) =>
      s.on("POST /api/app/issues/WH-1/jobs", { job: job("f6", { state: "offered" }) }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("button", { name: "Start over" }));
    await screen.findByRole("list", { name: "Runs" });
    const sent = server.sent("POST /api/app/issues/WH-1/jobs").map((c) => c.body);
    expect(sent).toEqual([
      { deviceId: "dev-1", model: "sonnet", continuesJobId: "e5" },
      { deviceId: "dev-1", repositoryId: "repo-1", model: "sonnet", baseBranch: "ui-changes" },
    ]);
  });

  test("a run that pushed nothing can only start over, unless it was stopped or lost; a continuation says so", async () => {
    mount([
      job("n1", { delivery: "none", result: { pushed: false } }),
      job("n2", { continuesJobId: "n0" }),
      job("n3", { state: "canceled", delivery: "none", result: {} }),
      job("n4", { state: "lost", delivery: "none", result: {}, error: "The device stopped reporting" }),
    ]);
    const items = within(await screen.findByRole("list", { name: "Runs" })).getAllByRole("listitem");
    expect(within(items[0]).queryByRole("button", { name: "Continue" })).toBeNull();
    expect(within(items[0]).getByRole("button", { name: "Start over" })).toBeTruthy();
    expect(within(items[1]).getByText(/continues an earlier run/)).toBeTruthy();
    expect(within(items[2]).getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(within(items[3]).getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  test("an unreachable run says it is not lost, offers Stop and Mark as lost, and marking asks first", async () => {
    const { server } = mount([job("u1", { state: "unreachable", delivery: null, result: {}, unreachableSince: new Date().toISOString(), lastHeardAt: new Date().toISOString() })], (s) =>
      s.on("POST /api/app/jobs/u1/mark-lost", { job: job("u1", { state: "lost", markedLost: true, error: "Marked lost by Atharva" }) }),
    );
    const item = within(await screen.findByRole("list", { name: "Runs" })).getByRole("listitem");
    expect(within(item).getByText("unreachable")).toBeTruthy();
    expect(within(item).getByText(/not lost/)).toBeTruthy();
    expect(within(item).getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(within(item).queryByRole("button", { name: "Continue" })).toBeNull();
    await userEvent.click(within(item).getByRole("button", { name: "Mark as lost" }));
    expect(server.sent("POST /api/app/jobs/u1/mark-lost")).toHaveLength(0);
    expect(screen.getByText(/the old run is stopped when the machine comes back/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Mark as lost" }));
    await screen.findByRole("list", { name: "Runs" });
    expect(server.sent("POST /api/app/jobs/u1/mark-lost")).toHaveLength(1);
  });

  test("a run that finished after a newer run took its branch says no pull request was opened", async () => {
    mount([job("s1", { state: "canceled", delivery: "pushed", result: { pushed: true, supersededBy: "s2" } })]);
    expect(await screen.findByText(/took over this branch/)).toBeTruthy();
  });

  test("a run in progress offers Stop, not a rerun; a refusal from the server is shown", async () => {
    mount([job("g7", { state: "running", delivery: null, result: {} }), job("h8")], (s) => s.on("POST /api/app/issues/WH-1/jobs", apiError(409, "conflict", "Atharva's MacBook Pro is offline.")));
    await screen.findByRole("list", { name: "Runs" });
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Continue" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("offline");
  });
});
