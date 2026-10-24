import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { DeviceJobState } from "../../db/schema";
import { GithubApiError, type GithubApi } from "../github/api";
import { github } from "../github/runtime";
import { ServiceError } from "../../lib/service";
import { type Device, MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_JOB, UNREACHABLE_AFTER_MS, isFinalState, str } from "./device-common";
import { signalJob } from "./device-stream";
import { revive, supersede, takenOverBy } from "./device-reports";
import { deviceJob, finishJobRow, transition } from "./job-state";

/** A job from the machine's side: accept, reject, progress, finish (and the pull request), and the sweep. See wheelhouse-cli/daemon/DESIGN.md. */
const { devices, deviceJobs, deviceJobEvents, issues, repositories, teams } = schema;

/** The daemon takes the job: it has a free slot and the repository. Too late (expired, canceled) is a conflict. */
export async function acceptJob(device: Device, jobId: string) {
  const j = await deviceJob(device, jobId);
  if (j.state === "offered" && j.offerExpiresAt < new Date()) {
    await transition(j.id, ["offered"], { state: "expired", finishedAt: new Date() });
    throw new ServiceError("conflict", "The offer expired");
  }
  if (j.cancelRequestedAt) throw new ServiceError("conflict", "The job was canceled");
  const row = await transition(j.id, ["offered"], { state: "accepted", acceptedAt: new Date() });
  if (!row) throw new ServiceError("conflict", `The job is ${j.state}`);
  return { job: { id: row.id, state: row.state } };
}

export const REJECT_REASONS = ["no_free_slot", "unknown_repository", "bad_signature", "expired", "unsupported_model", "not_ready"] as const;

export async function rejectJob(device: Device, jobId: string, input: Record<string, unknown>) {
  const j = await deviceJob(device, jobId);
  const reason = (REJECT_REASONS as readonly string[]).includes(input.reason as string) ? (input.reason as string) : "not_ready";
  const detail = str(input.detail, 500);
  const row = await transition(j.id, ["offered"], { state: "rejected", finishedAt: new Date(), error: detail ? `${reason}: ${detail}` : reason });
  if (!row) throw new ServiceError("conflict", `The job is ${j.state}`);
  return { job: { id: row.id, state: row.state } };
}

/**
 * `{ events: [{ seq, at, type, data }] }`: a batch of progress. `seq` is the daemon's own number for the event, so a batch sent again
 * after a dropped connection is stored once. A `started` event moves an accepted job to running.
 */
export async function recordJobEvents(device: Device, jobId: string, input: Record<string, unknown>) {
  let j = await deviceJob(device, jobId);
  // Progress from the device is proof it is alive: an unreachable run, or one a person marked lost that nobody has taken over, comes back.
  if (j.state === "lost" && j.markedLostBy) {
    if (await takenOverBy(j)) {
      await supersede(device, j);
      throw new ServiceError("conflict", "A newer run took over this branch, so this one is being stopped");
    }
    j = (await revive(j, ["lost"])) ?? j;
  } else if (j.state === "unreachable") j = (await revive(j, ["unreachable"])) ?? j;
  if (isFinalState(j.state)) throw new ServiceError("conflict", `The job is ${j.state}`);
  const list = Array.isArray(input.events) ? input.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
  const rows = list
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
    .filter((e) => Number.isInteger(e.seq) && (e.seq as number) >= 0 && (e.seq as number) < MAX_EVENTS_PER_JOB && str(e.type, 60))
    .map((e) => {
      const at = new Date(typeof e.at === "string" ? e.at : NaN);
      const data = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {};
      // One event's data is a summary, not a transcript: oversized payloads are cut to a note.
      const small = JSON.stringify(data).length <= 8_000 ? data : { truncated: true };
      return { jobId: j.id, seq: e.seq as number, at: Number.isNaN(at.getTime()) ? new Date() : at, type: str(e.type, 60), data: small };
    });
  const db = await getDb();
  if (rows.length) await db.insert(deviceJobEvents).values(rows).onConflictDoNothing();
  if (j.state === "accepted" && rows.some((r) => r.type === "started")) await transition(j.id, ["accepted"], { state: "running", startedAt: new Date() });
  else signalJob(j, 2_000);
  return { stored: rows.length };
}

export type PullRequestOpener = { api: Pick<GithubApi, "openPullRequest"> } | null;

/**
 * `{ state: succeeded | failed | canceled, branch?, commit?, diffStats?, costUsd?, error? }`: the daemon is done with the job. A
 * succeeded job that pushed changes gets a pull request, opened by the GitHub App (see `openJobPullRequest`).
 * A job already marked lost takes the daemon's word over: the real outcome replaces `lost`. If a newer run has taken the branch over
 * meanwhile, the outcome is still recorded (with `supersededBy`) but no pull request is opened: the branch is for a person to sort out.
 */
export async function finishJob(device: Device, jobId: string, input: Record<string, unknown>, gh: PullRequestOpener = github()) {
  const j = await deviceJob(device, jobId);
  const state = input.state as DeviceJobState;
  if (!["succeeded", "failed", "canceled"].includes(state)) throw new ServiceError("invalid", "state must be succeeded, failed or canceled");
  const stats = (input.diffStats && typeof input.diffStats === "object" ? input.diffStats : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const result = {
    commit: /^[0-9a-f]{7,40}$/.test(str(input.commit, 40)) ? str(input.commit, 40) : null,
    pushed: input.pushed === true,
    diffStats: { files: num(stats.files), insertions: num(stats.insertions), deletions: num(stats.deletions) },
    costUsd: num(input.costUsd),
    durationMs: num(input.durationMs),
  };
  const error = state === "succeeded" ? null : str(input.error, 2000) || null;
  const supersededBy = j.state === "lost" ? await takenOverBy(j) : null;
  const row =
    j.state === "lost"
      ? await transition(j.id, ["lost"], { state, finishedAt: new Date(), error, markedLostBy: null, result: supersededBy ? { ...result, supersededBy } : result })
      : await finishJobRow(j, state, { error, result });
  if (!row) {
    if (j.state === state) return { job: { id: j.id, state: j.state } }; // the same finish, sent again
    throw new ServiceError("conflict", `The job is ${j.state}`);
  }
  // Only the finish that moved the job opens one, so a finish sent again never opens a second.
  if (!supersededBy && state === "succeeded" && result.pushed && result.commit && result.diffStats.files !== 0) await openJobPullRequest(row, device, gh);
  return { job: { id: row.id, state: row.state } };
}

/**
 * The run's pull request, from its branch into the branch it started from. It is opened ready for review, not as a draft, so the
 * pull request rules move the issue to Review. A refusal is recorded on the run (`result.pullRequestError`), and a repository the App cannot reach as a note (`pullRequestSkipped`); neither fails the
 * finish: the branch is pushed either way, and a person can open the pull request by hand.
 */
export async function openJobPullRequest(j: typeof deviceJobs.$inferSelect, device: Device, gh: PullRequestOpener) {
  const db = await getDb();
  const [row] = await db
    .select({ issue: issues, teamKey: teams.key, repo: repositories })
    .from(issues)
    .innerJoin(teams, eq(teams.id, issues.teamId))
    .innerJoin(repositories, eq(repositories.id, j.repositoryId!))
    .where(eq(issues.id, j.issueId));
  let outcome: Record<string, unknown>;
  if (!row) return;
  // A continuation pushes to a branch that may already have its pull request: the push updated it, so it is this run's too.
  const [earlier] = await db
    .select({ result: deviceJobs.result })
    .from(deviceJobs)
    .where(and(eq(deviceJobs.branch, j.branch), eq(deviceJobs.repositoryId, j.repositoryId!), sql`${deviceJobs.id} <> ${j.id}`, sql`${deviceJobs.result} ? 'pullRequest'`))
    .orderBy(desc(deviceJobs.createdAt))
    .limit(1);
  if (earlier) {
    const [updated] = await db
      .update(deviceJobs)
      .set({ result: sql`${deviceJobs.result} || ${JSON.stringify({ pullRequest: earlier.result.pullRequest })}::jsonb`, updatedAt: new Date() })
      .where(eq(deviceJobs.id, j.id))
      .returning();
    if (updated) signalJob(updated);
    return;
  }
  // Not an error: without the App no pull request was ever expected, so the run just reads as pushed.
  if (!gh || !row.repo.githubInstallationId || !row.repo.githubRepoId)
    outcome = { pullRequestSkipped: "The GitHub App is not set up for this repository, so no pull request was opened" };
  else {
    const ref = `${row.teamKey}-${row.issue.number}`;
    const r = j.result as { costUsd?: number | null; diffStats?: { files: number | null; insertions: number | null; deletions: number | null } };
    const stats = r.diffStats?.files != null ? `${r.diffStats.files} files, +${r.diffStats.insertions ?? 0} −${r.diffStats.deletions ?? 0}` : null;
    const body = [
      `Agent run for ${ref}: ${row.issue.title}`,
      "",
      [`Run on ${device.name} with ${j.model}`, stats, r.costUsd != null ? `~$${r.costUsd.toFixed(2)}` : null].filter(Boolean).join(" · "),
      "",
      "Opened by the Wheelhouse daemon. An agent wrote these commits; review them before merging.",
    ].join("\n");
    try {
      const pr = await gh.api.openPullRequest(row.repo.githubInstallationId, row.repo.githubRepoId, {
        title: `${ref}: ${row.issue.title}`,
        head: j.branch,
        base: j.baseBranch || row.repo.defaultBranch || "main",
        body,
      });
      outcome = { pullRequest: pr };
    } catch (e) {
      const status = e instanceof GithubApiError ? e.status : null;
      outcome = {
        pullRequestError:
          status === 403
            ? "GitHub refused: the App needs the \"Pull requests: Read and write\" permission"
            : status === 422
              ? "GitHub refused: the branch has no changes against its base, or a pull request for it is already open"
              : `Could not open the pull request (${e instanceof Error ? e.message : "unknown error"})`,
      };
    }
  }
  const [updated] = await db
    .update(deviceJobs)
    .set({ result: sql`${deviceJobs.result} || ${JSON.stringify(outcome)}::jsonb`, updatedAt: new Date() })
    .where(eq(deviceJobs.id, j.id))
    .returning();
  if (updated) signalJob(updated);
}

/**
 * Time-based moves, run every so often by the host: offers nobody accepted expire, and jobs on a device that went silent become
 * unreachable. Silence never loses a job: it goes on waiting until the daemon reports it (`reconcileJobs`) or a person marks it lost
 * (`markJobLost`). Returns how many of each, for the log.
 */
export async function sweepDeviceJobs(now = new Date()) {
  const db = await getDb();
  const expired = await db
    .update(deviceJobs)
    .set({ state: "expired", finishedAt: now, updatedAt: now })
    .where(and(eq(deviceJobs.state, "offered"), lt(deviceJobs.offerExpiresAt, now)))
    .returning();
  const silent = db.select({ id: devices.id }).from(devices).where(or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, new Date(now.getTime() - UNREACHABLE_AFTER_MS))));
  const unreachable = await db
    .update(deviceJobs)
    .set({ state: "unreachable", unreachableSince: now, updatedAt: now })
    .where(and(inArray(deviceJobs.state, ["accepted", "running"]), inArray(deviceJobs.deviceId, silent)))
    .returning();
  for (const j of [...expired, ...unreachable]) signalJob(j);
  return { expired: expired.length, unreachable: unreachable.length };
}
