import { Inject, Injectable } from "@nestjs/common";
import type { DeviceJobState } from "../../db/schema";
import { Database } from "../../platform/database/database";
import { GithubApiError, github, type GithubApi } from "../github/index";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { DaemonRepository, type DeviceRow, type JobRow } from "./daemon.repository";
import { LEARNINGS_CAP, REJECT_REASONS, cleanCapabilities, proposedLearnings } from "./daemon.rules";
import { ACTIVE, type Device, MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_JOB, UNREACHABLE_AFTER_MS, isFinalState, str } from "./device-common";
import { DeviceStreamService } from "./device-stream.service";
import { RunNotifications } from "./runs.notifications";

export type PullRequestOpener = { api: Pick<GithubApi, "openPullRequest"> } | null;

/**
 * A job from the machine's side: what a device reports (hello, heartbeat, and settling what it says it still holds), accept, reject,
 * progress, finish (and the pull request), and the sweep. Every method takes the device the token names and reaches its jobs by job id
 * AND device id. The only other thing it uses is the GitHub App's plain API client (no module, no database). See wheelhouse-cli/daemon/DESIGN.md.
 */
@Injectable()
export class DeviceJobsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DeviceStreamService) private readonly stream: DeviceStreamService,
    @Inject(RunNotifications) private readonly notices: RunNotifications,
  ) {}

  // ───────── a job's row ─────────

  /** A device's job: found by its id AND the device's id, so another device's job is not_found. */
  async deviceJob(device: Device, jobId: string) {
    if (!isUuid(jobId)) throw new ServiceError("not_found", "No such job");
    const j = await this.repo.jobOfDevice(jobId, device.id);
    if (!j) throw new ServiceError("not_found", "No such job");
    return j;
  }

  /** Move a job to the patch's state only if it is still in one of `from` (one place, so two writers cannot both win); null when something else got there first. */
  async transition(jobId: string, from: DeviceJobState[], set: Parameters<DaemonRepository["moveJob"]>[2]) {
    const row = await this.repo.moveJob(jobId, from, set);
    if (row) this.stream.signalJob(row);
    return row ?? null;
  }

  private finishJobRow(j: JobRow, state: DeviceJobState, extra: { error?: string | null; result?: Record<string, unknown> } = {}) {
    return this.transition(j.id, ACTIVE, { state, finishedAt: new Date(), error: extra.error ?? null, ...(extra.result ? { result: extra.result } : {}) });
  }

  // ───────── what the machine reports ─────────

  /**
   * `{ version, capabilities, jobs: [{ id, state }] }`, sent each time the daemon connects. Records what the machine can do now, and
   * reconciles (`reconcileJobs`): a job the daemon still holds is running again, one it no longer knows about (it restarted and lost it) is lost.
   */
  async hello(device: Device, input: Record<string, unknown>) {
    const reported = new Set(
      (Array.isArray(input.jobs) ? input.jobs : [])
        .map((j) => (j && typeof j === "object" ? (j as Record<string, unknown>).id : null))
        .filter(isUuid),
    );
    const d = await this.repo.updateDevice(device.id, { daemonVersion: str(input.version, 40) || null, capabilities: cleanCapabilities(input.capabilities), lastSeenAt: new Date() });
    await this.reconcileJobs(device, reported, "hello");
    return { device: { id: d.id, name: d.name, poolSize: d.poolSize, chatModel: d.chatModel } };
  }

  /** `{ running: [jobId], free, onBattery }`, every 30 seconds. Keeps the device online, and settles its unreachable jobs the way a hello does. */
  async heartbeat(device: Device, input: Record<string, unknown>) {
    const caps = { ...(device.capabilities ?? {}), power: { onBattery: input.onBattery === true }, pool: { free: Number.isInteger(input.free) ? input.free : null } };
    await this.repo.updateDevice(device.id, { lastSeenAt: new Date(), capabilities: caps });
    await this.reconcileJobs(device, new Set((Array.isArray(input.running) ? input.running : []).filter((id): id is string => typeof id === "string" && isUuid(id))), "heartbeat");
    return { ok: true as const };
  }

  /**
   * What the daemon says it holds is the only evidence a run is gone. For this device's jobs:
   * - an unreachable job the daemon reports is running again; one it does not report is lost (it is no longer there);
   * - a hello (the daemon just started) that leaves out an accepted or running job loses it too, since a restart forgets its jobs. A
   *   heartbeat does not: its list can be a moment older than an accept;
   * - a job a person marked lost that the daemon still reports comes back, unless a newer run has taken over its branch, in which case
   *   the old agent is told to stop (`supersede`).
   */
  async reconcileJobs(device: Device, reported: Set<string>, source: "hello" | "heartbeat") {
    const states: DeviceJobState[] = source === "hello" ? ["accepted", "running", "unreachable"] : ["unreachable"];
    const open = await this.repo.jobsOfDeviceInStates(device.id, states);
    for (const j of open) {
      if (reported.has(j.id)) {
        if (j.state === "unreachable") await this.revive(j, ["unreachable"]);
      } else {
        await this.finishJobRow(j, "lost", { error: source === "hello" ? "The daemon restarted and no longer has this job" : "The daemon no longer has this job" });
      }
    }
    if (!reported.size) return;
    for (const j of await this.repo.markedLostJobs(device.id, [...reported])) {
      if (await this.takenOverBy(j)) await this.supersede(device, j);
      else await this.revive(j, ["lost"]);
    }
  }

  /** Back to running (or setting up, if it had not started): the device is talking about it after all. */
  private revive(j: JobRow, from: DeviceJobState[]) {
    return this.transition(j.id, from, { state: j.startedAt ? "running" : "accepted", unreachableSince: null, finishedAt: null, error: null, markedLostBy: null });
  }

  /** The id of a newer run on this run's branch (one that was offered and not refused), if there is one: it has taken the branch over. */
  private takenOverBy(j: JobRow) {
    return this.repo.newerRunOnBranch(j);
  }

  /** Tell a device whose run was taken over to stop it, without pushing. Asked once: the daemon answers with its finish. */
  private async supersede(device: Device, j: JobRow) {
    if (j.cancelRequestedAt) return;
    const key = await this.stream.signingKey();
    await this.db.transaction(async () => {
      const row = await this.repo.requestCancelOnce(j.id, new Date());
      if (row) await this.stream.send(key, device.id, "job.cancel", { jobId: j.id, superseded: true });
    });
    this.stream.wake(device.id);
  }

  // ───────── a job's life ─────────

  /** The daemon takes the job: it has a free slot and the repository. Too late (expired, canceled) is a conflict. */
  async acceptJob(device: Device, jobId: string) {
    const j = await this.deviceJob(device, jobId);
    if (j.state === "offered" && j.offerExpiresAt < new Date()) {
      await this.transition(j.id, ["offered"], { state: "expired", finishedAt: new Date() });
      throw new ServiceError("conflict", "The offer expired");
    }
    if (j.cancelRequestedAt) throw new ServiceError("conflict", "The job was canceled");
    const row = await this.transition(j.id, ["offered"], { state: "accepted", acceptedAt: new Date() });
    if (!row) throw new ServiceError("conflict", `The job is ${j.state}`);
    return { job: { id: row.id, state: row.state } };
  }

  async rejectJob(device: Device, jobId: string, input: Record<string, unknown>) {
    const j = await this.deviceJob(device, jobId);
    const reason = (REJECT_REASONS as readonly string[]).includes(input.reason as string) ? (input.reason as string) : "not_ready";
    const detail = str(input.detail, 500);
    const row = await this.transition(j.id, ["offered"], { state: "rejected", finishedAt: new Date(), error: detail ? `${reason}: ${detail}` : reason });
    if (!row) throw new ServiceError("conflict", `The job is ${j.state}`);
    return { job: { id: row.id, state: row.state } };
  }

  /**
   * `{ events: [{ seq, at, type, data }] }`: a batch of progress. `seq` is the daemon's own number for the event, so a batch sent again
   * after a dropped connection is stored once. A `started` event moves an accepted job to running.
   */
  async recordJobEvents(device: Device, jobId: string, input: Record<string, unknown>) {
    let j = await this.deviceJob(device, jobId);
    // Progress from the device is proof it is alive: an unreachable run, or one a person marked lost that nobody has taken over, comes back.
    if (j.state === "lost" && j.markedLostBy) {
      if (await this.takenOverBy(j)) {
        await this.supersede(device, j);
        throw new ServiceError("conflict", "A newer run took over this branch, so this one is being stopped");
      }
      j = (await this.revive(j, ["lost"])) ?? j;
    } else if (j.state === "unreachable") j = (await this.revive(j, ["unreachable"])) ?? j;
    if (isFinalState(j.state)) throw new ServiceError("conflict", `The job is ${j.state}`);
    const list = Array.isArray(input.events) ? input.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
    const rows = list
      .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
      .filter((e) => Number.isInteger(e.seq) && (e.seq as number) >= 0 && (e.seq as number) < MAX_EVENTS_PER_JOB && str(e.type, 60))
      .map((e) => {
        const at = new Date(typeof e.at === "string" ? e.at : NaN);
        const data = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {};
        // One event's data is a summary, not a transcript: oversized payloads are cut to a note.
        const small = JSON.stringify(data).length <= 40_000 ? data : { truncated: true };
        return { jobId: j.id, seq: e.seq as number, at: Number.isNaN(at.getTime()) ? new Date() : at, type: str(e.type, 60), data: small };
      });
    if (rows.length) await this.repo.insertEvents(rows);
    if (j.state === "accepted" && rows.some((r) => r.type === "started")) await this.transition(j.id, ["accepted"], { state: "running", startedAt: new Date() });
    else this.stream.signalJob(j, 2_000);
    return { stored: rows.length };
  }

  /**
   * `{ state: succeeded | failed | canceled, branch?, commit?, diffStats?, costUsd?, error? }`: the daemon is done with the job. A
   * succeeded job that pushed changes gets a pull request, opened by the GitHub App (see `openJobPullRequest`).
   * A job already marked lost takes the daemon's word over: the real outcome replaces `lost`. If a newer run has taken over the branch
   * meanwhile, the outcome is still recorded (with `supersededBy`) but no pull request is opened: the branch is for a person to sort out.
   */
  async finishJob(device: Device, jobId: string, input: Record<string, unknown>, gh: PullRequestOpener = github()) {
    const j = await this.deviceJob(device, jobId);
    const state = input.state as DeviceJobState;
    if (!["succeeded", "failed", "canceled"].includes(state)) throw new ServiceError("invalid", "state must be succeeded, failed or canceled");
    const stats = (input.diffStats && typeof input.diffStats === "object" ? input.diffStats : {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    // WH-118: an agent that stops to ask ends its last message with "QUESTION: ..."; the run is then waiting for an answer, not finished work.
    const said = state === "succeeded" ? (await this.repo.lastResultEvent(j.id))?.data?.text : null;
    const question = typeof said === "string" && /^\s*QUESTION:/i.test(said) ? said.replace(/^\s*QUESTION:\s*/i, "").trim().slice(0, 20_000) : null;
    const result = {
      ...(question ? { question } : {}),
      commit: /^[0-9a-f]{7,40}$/.test(str(input.commit, 40)) ? str(input.commit, 40) : null,
      pushed: input.pushed === true,
      diffStats: { files: num(stats.files), insertions: num(stats.insertions), deletions: num(stats.deletions) },
      costUsd: num(input.costUsd),
      durationMs: num(input.durationMs),
    };
    const error = state === "succeeded" ? null : str(input.error, 2000) || null;
    const supersededBy = j.state === "lost" ? await this.takenOverBy(j) : null;
    const row =
      j.state === "lost"
        ? await this.transition(j.id, ["lost"], { state, finishedAt: new Date(), error, markedLostBy: null, result: supersededBy ? { ...result, supersededBy } : result })
        : await this.finishJobRow(j, state, { error, result });
    if (!row) {
      if (j.state === state) return { job: { id: j.id, state: j.state } }; // the same finish, sent again
      throw new ServiceError("conflict", `The job is ${j.state}`);
    }
    // Only the finish that moved the job tells the person who started it, so a finish sent again does not (and `lost`, `canceled` say nothing).
    // WH-124: what the agent says it learned about this team, kept (a few a run, capped) for its later runs here.
    const learned = proposedLearnings(input.learnings);
    if (j.agentId && state === "succeeded" && !question && learned.length) await this.repo.addLearnings({ id: j.teamId, workspaceId: j.workspaceId }, j.agentId, learned, LEARNINGS_CAP);
    await this.notices.summary(device, row);
    if (state === "succeeded" || state === "failed") await this.notices.finished(device, row);
    // Only the finish that moved the job opens one, so a finish sent again never opens a second.
    if (!supersededBy && state === "succeeded" && !question && j.mode === "work" && result.pushed && result.commit && result.diffStats.files !== 0) await this.openJobPullRequest(row, device, gh);
    return { job: { id: row.id, state: row.state } };
  }

  /**
   * The run's pull request, from its branch into the branch it started from. It is opened ready for review, not as a draft, so the
   * pull request rules move the issue to Review. A refusal is recorded on the run (`result.pullRequestError`), and a repository the App cannot reach as a note (`pullRequestSkipped`); neither fails the
   * finish: the branch is pushed either way, and a person can open the pull request by hand.
   */
  async openJobPullRequest(j: JobRow, device: DeviceRow, gh: PullRequestOpener) {
    const row = await this.repo.pullRequestContext(j.issueId, j.repositoryId!);
    let outcome: Record<string, unknown>;
    if (!row) return;
    // A continuation pushes to a branch that may already have its pull request: the push updated it, so it is this run's too.
    const earlier = await this.repo.earlierPullRequest(j);
    if (earlier) {
      const updated = await this.repo.mergeResult(j.id, { pullRequest: earlier.result.pullRequest });
      if (updated) this.stream.signalJob(updated);
      return;
    }
    // Not an error: without the App no pull request was ever expected, so the run just reads as pushed.
    if (!gh || !row.repo.githubInstallationId || !row.repo.githubRepoId) outcome = { pullRequestSkipped: "The GitHub App is not set up for this repository, so no pull request was opened" };
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
    const updated = await this.repo.mergeResult(j.id, outcome);
    if (updated) this.stream.signalJob(updated);
  }

  // ───────── the sweep ─────────

  /**
   * Time-based moves, run every so often by the host: offers nobody accepted expire, and jobs on a device that went silent become
   * unreachable. Silence never loses a job: it goes on waiting until the daemon reports it (`reconcileJobs`) or a person marks it lost
   * (`markJobLost`). Returns how many of each, for the log.
   */
  async sweep(now = new Date()) {
    const expired = await this.repo.expireOffers(now);
    const unreachable = await this.repo.markUnreachable(now, new Date(now.getTime() - UNREACHABLE_AFTER_MS));
    for (const j of [...expired, ...unreachable]) this.stream.signalJob(j);
    return { expired: expired.length, unreachable: unreachable.length };
  }
}
