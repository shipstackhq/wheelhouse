import type { JobState, JobView } from "@wheelhouse/api-client";

type RunLike = Pick<JobView, "state" | "delivery" | "cancelRequested">;

const ACTIVE: JobState[] = ["offered", "accepted", "running"];
export const isActive = (state: JobState) => ACTIVE.includes(state);

/** How a status chip is coloured: running, went well, needs a look, went wrong, or nothing to say. */
export type Tone = "active" | "good" | "warn" | "bad" | "muted";

/** "Succeeded" only says the run ended cleanly; a run that left the repository as it found it is its own outcome. */
export const madeNoChanges = (job: Pick<JobView, "state" | "delivery">) => job.state === "succeeded" && job.delivery === "none";

/**
 * What a run's chip says, from how it ended (`state`) and what it left behind (`delivery`): a clean run with a pull request reads
 * "PR opened", one whose pull request GitHub refused reads "no PR" (the branch is still pushed), and "done" is never shown on its own.
 */
export function runStatus(job: RunLike): { label: string; tone: Tone } {
  if (isActive(job.state)) {
    if (job.cancelRequested) return { label: "stopping", tone: "active" };
    return { label: { offered: "waiting for the device", accepted: "setting up", running: "running" }[job.state as "offered" | "accepted" | "running"], tone: "active" };
  }
  switch (job.state) {
    case "succeeded":
      switch (job.delivery) {
        case "pr_opened":
          return { label: "PR opened", tone: "good" };
        case "pr_failed":
          return { label: "no PR", tone: "warn" };
        case "none":
          return { label: "no changes", tone: "muted" };
        default:
          return { label: "pushed", tone: "good" };
      }
    case "failed":
      return { label: "failed", tone: "bad" };
    case "canceled":
      return { label: "stopped", tone: "muted" };
    case "rejected":
      return { label: "refused", tone: "warn" };
    case "expired":
      return { label: "not picked up", tone: "muted" };
    default:
      return { label: "lost", tone: "warn" };
  }
}

export const runStatusLabel = (job: RunLike) => runStatus(job).label;
