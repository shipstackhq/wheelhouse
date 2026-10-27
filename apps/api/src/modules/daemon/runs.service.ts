import crypto from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { Database } from "../../platform/database/database";
import { RepositoriesService, github, type RepositoryRow } from "../github/index";
import { agentName, toAgentsJson } from "@wheelhouse/shared/agents/render";
import { effectiveProfile } from "../agents/index";
import { IssuesService } from "../issues/index";
import { DaemonRepository } from "./daemon.repository";
import { deviceOnline, deviceView, jobView } from "./daemon.presenter";
import { jobBranch, validBaseBranch } from "./daemon.rules";
import { ACTIVE, OFFER_TTL_MS, isFinalState, str } from "./device-common";
import { DeviceJobsService } from "./device-jobs.service";
import { DeviceStreamService } from "./device-stream.service";
import { DevicesService } from "./devices.service";

/**
 * A person's runs on an issue: start, list, follow, stop, mark lost. The person's side, so it is part of the api role: the issue is
 * reached through the issues module (`resolveIssue`, which checks the person's role on the team), the team's repositories through the
 * github module, and a job is read only through its issue's team. See wheelhouse-cli/daemon/DESIGN.md.
 */
@Injectable()
export class RunsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DeviceStreamService) private readonly stream: DeviceStreamService,
    @Inject(DeviceJobsService) private readonly jobs: DeviceJobsService,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(IssuesService) private readonly issues: IssuesService,
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
  ) {}

  /** The repositories of a team an agent can work in from a fresh clone: connected to GitHub and not retired. */
  async runnableRepositories(actor: Actor, teamKey: string): Promise<{ all: RepositoryRow[]; runnable: RepositoryRow[] }> {
    const all = await this.repositories.listRepositories(actor, teamKey);
    return { all, runnable: all.filter((r) => r.provider === "github" && r.githubFullName && r.lifecycle !== "retired") };
  }

  /**
   * The issue's runs, newest first, and what a new one can use: the person's own online devices, the team's GitHub repositories, and
   * the models each device offers. Anyone who can read the issue sees its runs.
   */
  async issueJobs(actor: Actor, ref: string) {
    const { issue, team } = await this.issues.resolveIssue(actor, ref);
    const rows = await this.repo.issueRuns(issue.id, team.id);
    const { all, runnable } = await this.runnableRepositories(actor, team.key);
    const names = new Map(all.map((r) => [r.id, r.displayName]));
    const mine = actor.kind === "human" ? await this.devices.listDevices(actor) : [];
    return {
      jobs: rows.map((r) => jobView(r.job, { deviceName: r.deviceName, repositoryName: r.job.repositoryId ? (names.get(r.job.repositoryId) ?? null) : null, lastHeardAt: r.lastHeardAt })),
      devices: mine.map((d) => ({ id: d.id, name: d.name, status: d.status, models: d.models, poolSize: d.poolSize, activeJobs: d.activeJobs })),
      repositories: runnable.map((r) => ({ id: r.id, name: r.displayName, fullName: r.githubFullName, defaultBranch: r.defaultBranch })),
    };
  }

  /**
   * The branches a run of the issue can start from, in one of its team's repositories: from GitHub when the server has the App, the
   * default branch first. Without GitHub (or when it fails) just the default branch, and `listed: false` so the page offers a text box.
   */
  async runBranches(actor: Actor, ref: string, repositoryId: string) {
    const { team } = await this.issues.resolveIssue(actor, ref);
    const repo = (await this.runnableRepositories(actor, team.key)).runnable.find((r) => r.id === repositoryId);
    if (!repo) throw new ServiceError("not_found", "Repository not found");
    const def = repo.defaultBranch || "main";
    const gh = github();
    if (!gh || !repo.githubInstallationId || !repo.githubRepoId) return { defaultBranch: def, branches: [def], listed: false };
    try {
      const names = await gh.api.branches(repo.githubInstallationId, repo.githubRepoId);
      return { defaultBranch: def, branches: [def, ...names.filter((n) => n !== def).sort()], listed: true };
    } catch {
      return { defaultBranch: def, branches: [def], listed: false };
    }
  }

  /**
   * The earlier run a "Continue" carries on from: one of this issue's runs that has finished and pushed its branch, with no other run on
   * that branch right now (two agents on one branch would push over each other). Its final summary is handed to the new run.
   */
  private async continuable(issueId: string, jobId: unknown) {
    const id = str(jobId, 60);
    const job = isUuid(id) ? await this.repo.jobOfIssue(id, issueId) : undefined;
    if (!job) throw new ServiceError("invalid", "There is no such run of this issue to continue", { fields: { continuesJobId: "a run of this issue" } });
    if (job.state === "unreachable") throw new ServiceError("conflict", "That run cannot be reached. If it is gone, mark it lost first, then continue it");
    if (!isFinalState(job.state)) throw new ServiceError("conflict", "That run has not finished yet");
    // A run that was stopped or lost can be picked up again even if it never pushed; any other run needs a push to continue from.
    const pushed = job.result?.pushed === true;
    if (!pushed && job.state !== "canceled" && job.state !== "lost") throw new ServiceError("invalid", "That run pushed nothing, so there is nothing to continue from: start over instead");
    if (await this.repo.activeRunOnBranch(job.branch, ACTIVE)) throw new ServiceError("conflict", "Another run is already working on that branch");
    const last = await this.repo.lastResultEvent(job.id);
    const summary = typeof last?.data?.text === "string" ? (last.data.text as string) : null;
    return { job, summary, pushed };
  }

  /**
   * "Run on device": `{ deviceId, repositoryId?, model, baseBranch?, continuesJobId? }`. With `continuesJobId` the new run works on that
   * earlier run's branch, from its commits, with the same repository and pull request target; otherwise it starts a new branch. The person must be able to edit the issue and own the device, which must be
   * online. The repository is one of the issue team's GitHub repositories (the only one, if the team has one). The job is offered to
   * the device as a signed message carrying everything it needs, and expires if the device does not take it within a minute.
   */
  async runOnDevice(actor: Actor, ref: string, input: Record<string, unknown>, agentId?: string) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can send work to their machine");
    const { issue, team, ref: issueRef } = await this.issues.resolveIssue(actor, ref, "edit");
    const device = await this.devices.ownDevice(actor, str(input.deviceId, 60)).catch(() => {
      throw new ServiceError("invalid", "Pick one of your devices", { fields: { deviceId: "one of your paired devices" } });
    });
    if (!deviceOnline(device)) throw new ServiceError("conflict", `${device.name} is offline. Start the daemon on it and try again.`);
    const repos = (await this.runnableRepositories(actor, team.key)).runnable;
    // "Continue": carry on from an earlier run of this issue, on its branch and from its commits, with what it said at the end.
    const previous = input.continuesJobId === undefined || input.continuesJobId === null ? null : await this.continuable(issue.id, input.continuesJobId);
    const repoId = previous ? (previous.job.repositoryId ?? "") : str(input.repositoryId, 60);
    const repo = repoId ? repos.find((r) => r.id === repoId) : repos.length === 1 ? repos[0] : undefined;
    if (!repo)
      throw new ServiceError("invalid", repos.length ? "Pick the repository to work in" : "This team has no GitHub repository the agent can clone yet", {
        fields: { repositoryId: repos.length ? "one of the team's GitHub repositories" : "connect a GitHub repository first" },
      });
    const view = deviceView(device);
    const model = str(input.model, 60);
    if (!model || !view.models.includes(model)) throw new ServiceError("invalid", `Pick a model ${device.name} offers: ${view.models.join(", ")}`, { fields: { model: view.models.join(", ") } });
    const baseBranch = previous
      ? previous.job.baseBranch || repo.defaultBranch || "main"
      : input.baseBranch === undefined || input.baseBranch === ""
        ? repo.defaultBranch || "main"
        : validBaseBranch(input.baseBranch);
    if (!baseBranch) throw new ServiceError("invalid", "That is not a branch name", { fields: { baseBranch: "a branch of the repository" } });

    // WH-114: a delegated run carries its agent's profile; the daemon shapes the run with it (WH-115). Without one it is a generic run.
    const agentRow = agentId ? await this.repo.workspaceAgent(agentId, actor.workspaceId) : undefined;
    const agent = agentRow ? { id: agentRow.id, slug: agentRow.slug, profile: effectiveProfile(agentRow) } : null;

    const id = crypto.randomUUID();
    const branch = previous ? previous.job.branch : jobBranch(issueRef, issue.title, id);
    const offerExpiresAt = new Date(Date.now() + OFFER_TTL_MS);
    const key = await this.stream.signingKey();
    const job = await this.db.transaction(async () => {
      const j = await this.repo.insertJob({ id, teamId: team.id, workspaceId: actor.workspaceId, deviceId: device.id, issueId: issue.id, repositoryId: repo.id, model, branch, baseBranch, continuesJobId: previous?.job.id ?? null, createdBy: actor.id, agentId: agent?.id ?? null, effort: agent?.profile.effort ?? null, offerExpiresAt });
      await this.stream.send(key, device.id, "job.offer", {
        jobId: j.id,
        workspaceId: j.workspaceId,
        expiresAt: offerExpiresAt.toISOString(),
        model,
        branch,
        baseBranch,
        // Where the worktree starts: the earlier run's pushed branch when continuing, else the base (also when a stopped or lost run never pushed).
        startFrom: previous?.pushed ? branch : baseBranch,
        previous: previous ? { jobId: previous.job.id, state: previous.job.state, summary: previous.summary, error: previous.job.error } : null,
        // Board writes come with the MCP redesign; until then the agent works only in its worktree.
        boardAccess: "none",
        issue: { id: issue.id, ref: issueRef, title: issue.title, body: issue.body, team: { key: team.key, name: team.name } },
        repository: {
          id: repo.id,
          name: repo.displayName,
          fullName: repo.githubFullName,
          cloneUrl: `https://github.com/${repo.githubFullName}.git`,
          defaultBranch: repo.defaultBranch,
          pathLimit: repo.pathLimit,
        },
        requestedBy: { id: actor.id, name: actor.name },
        // WH-115: the CLI's own agent definition (instructions with the guardrails, tools, effort); the daemon runs `claude --agents <definitions> --agent <name>`.
        agent: agent ? { slug: agent.slug, name: agentName(agent.profile), definitions: toAgentsJson(agent.profile) } : null,
      });
      return j;
    });
    this.stream.wake(device.id);
    this.stream.signalJob(job);
    return { job: jobView(job, { deviceName: device.name, repositoryName: repo.displayName }) };
  }

  /** A job the actor can read, through its issue's team. */
  async readableJob(actor: Actor, jobId: string) {
    if (!isUuid(jobId)) throw new ServiceError("not_found", "Job not found");
    const job = await this.repo.jobInWorkspace(jobId, actor.workspaceId);
    if (!job) throw new ServiceError("not_found", "Job not found");
    await this.issues.resolveIssue(actor, job.issueId).catch(() => {
      throw new ServiceError("not_found", "Job not found");
    });
    return job;
  }

  /** A job's progress after event `after` (exclusive), oldest first, at most `limit`. */
  async jobEvents(actor: Actor, jobId: string, opts: { after?: number; limit?: number } = {}) {
    const job = await this.readableJob(actor, jobId);
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
    const rows = await this.repo.eventsAfter(job.id, opts.after ?? -1, limit);
    const dev = job.state === "unreachable" ? await this.repo.deviceLastSeen(job.deviceId) : undefined;
    return { job: jobView(job, { lastHeardAt: dev?.lastSeenAt }), events: rows.map((e) => ({ seq: e.seq, at: e.at.toISOString(), type: e.type, data: e.data })) };
  }

  /**
   * Stop a job. An offer not yet taken ends at once; a job the daemon holds is asked to stop (a signed cancel) and ends when the daemon
   * reports it. The person who started it, the device's owner, or the issue's assignee (WH-127: the issue is theirs) can cancel.
   */
  async cancelJob(actor: Actor, jobId: string) {
    const job = await this.readableJob(actor, jobId);
    const d = await this.repo.deviceById(job.deviceId);
    const assignee = (await this.repo.issueForNotice(job.issueId))?.assigneeId;
    if (actor.kind !== "human" || (job.createdBy !== actor.id && d?.ownerId !== actor.id && assignee !== actor.id)) throw new ServiceError("forbidden", "Only the person who started it, the device's owner or the assignee can cancel a run");
    if (isFinalState(job.state)) return { job: jobView(job) };
    const now = new Date();
    const key = await this.stream.signingKey();
    const updated = await this.db.transaction(async () => {
      const row = job.state === "offered" ? await this.repo.cancelOffer(job.id, now, `Canceled by ${actor.name}`) : await this.repo.requestCancel(job.id, now);
      if (row) await this.stream.send(key, job.deviceId, "job.cancel", { jobId: job.id, requestedBy: { id: actor.id, name: actor.name } });
      return row;
    });
    this.stream.wake(job.deviceId);
    if (updated) this.stream.signalJob(updated);
    return { job: jobView(updated ?? job) };
  }

  /**
   * WH-116: stop an issue's active runs because its delegation changed. The caller has already checked that the actor may delegate the
   * issue, which is the permission that matters here, so this does not ask whether they started the run.
   */
  async stopIssueRuns(actor: Actor, issueId: string, teamId: string) {
    const now = new Date();
    const active = (await this.repo.issueRuns(issueId, teamId)).map((r) => r.job).filter((j) => !isFinalState(j.state));
    if (!active.length) return;
    const key = await this.stream.signingKey();
    for (const job of active) {
      const row = await this.db.transaction(async () => {
        const r = job.state === "offered" ? await this.repo.cancelOffer(job.id, now, `Stopped: delegation changed by ${actor.name}`) : await this.repo.requestCancel(job.id, now);
        if (r) await this.stream.send(key, job.deviceId, "job.cancel", { jobId: job.id, requestedBy: { id: actor.id, name: actor.name } });
        return r;
      });
      this.stream.wake(job.deviceId);
      if (row) this.stream.signalJob(row);
    }
  }

  /**
   * Mark an unreachable run lost, by hand: the person decides it is not coming back, which frees its branch to continue. Only an
   * unreachable run can be marked, by the device's owner or someone who can edit the issue. It is a guess, so it is not final: if the
   * device reports the run after all, it comes back (or, if a newer run took the branch, it is stopped; see `reconcileJobs`).
   */
  async markJobLost(actor: Actor, jobId: string) {
    const job = await this.readableJob(actor, jobId);
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can mark a run lost");
    const d = await this.repo.deviceById(job.deviceId);
    if (d?.ownerId !== actor.id) await this.issues.resolveIssue(actor, job.issueId, "edit");
    if (job.state === "lost") return { job: jobView(job, { deviceName: d?.name }) };
    if (job.state !== "unreachable") throw new ServiceError("conflict", "Only a run that cannot be reached can be marked lost");
    const row = await this.jobs.transition(job.id, ["unreachable"], { state: "lost", finishedAt: new Date(), markedLostBy: actor.id, error: `Marked lost by ${actor.name}` });
    if (!row) throw new ServiceError("conflict", "The device reconnected, so the run is not lost");
    return { job: jobView(row, { deviceName: d?.name }) };
  }
}
