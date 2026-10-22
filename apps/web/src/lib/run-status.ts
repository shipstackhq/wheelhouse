import type { JobState, JobView } from "@wheelhouse/api-client";

/** "Succeeded" only says the run ended cleanly; a run that left the repository as it found it is its own outcome. */
export function madeNoChanges(job: Pick<JobView, "state" | "result">): boolean {
  if (job.state !== "succeeded") return false;
  const files = job.result.diffStats?.files;
  return !job.result.pushed && !job.result.pullRequest && (files == null || files === 0);
}

const LABEL: Record<JobState, string> = {
  offered: "waiting for the device",
  accepted: "setting up",
  running: "running",
  succeeded: "done",
  failed: "failed",
  canceled: "canceled",
  rejected: "refused",
  expired: "not picked up",
  lost: "lost",
};

/** What a run's status chip says. */
export function runStatusLabel(job: Pick<JobView, "state" | "result" | "cancelRequested">): string {
  const active = job.state === "offered" || job.state === "accepted" || job.state === "running";
  if (job.cancelRequested && active) return "stopping";
  if (madeNoChanges(job)) return "finished, no changes";
  return LABEL[job.state];
}
