import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { Actor } from "../../common/actor";
import { ISSUE_COMMENTED, ISSUE_DELEGATED, IssuesService, type IssueCommented, type IssueDelegated } from "../issues/index";
import { DaemonRepository } from "./daemon.repository";
import { DevicesService } from "./devices.service";
import { RunPlanner } from "./run-planner";
import { RunNotifications } from "./runs.notifications";
import { RunsService } from "./runs.service";
import { ACTIVE } from "./device-common";

/** How often issues waiting for a device are offered again. */
const WAITING_EVERY_MS = 30_000;

/**
 * WH-116: delegating an issue starts a run, clearing (or changing) the delegate stops the active one. The run is the delegator's: on
 * where it runs comes from the issue's targets (`RunPlanner`). With no targets the issue needs setup: the requester is asked once and
 * nothing is retried until the targets are set. With no online device it waits, and is offered when one comes back. The api role's
 * side; a failure here is logged and never undoes the delegation.
 */
@Injectable()
export class DelegationService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("Delegation");
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(IssuesService) private readonly issues: IssuesService,
    @Inject(RunPlanner) private readonly planner: RunPlanner,
    @Inject(RunNotifications) private readonly notices: RunNotifications,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.stopOrphaned().catch((e) => this.log.warn(`stopping runs of people who left failed: ${e instanceof Error ? e.message : e}`));
      this.offerWaiting().catch((e) => this.log.warn(`offering waiting delegations failed: ${e instanceof Error ? e.message : e}`));
    }, WAITING_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  @OnEvent(ISSUE_DELEGATED)
  async onDelegated({ actor, issueId, ref, agentId }: IssueDelegated) {
    const { team, issue } = await this.issues.resolveIssue(actor, issueId);
    await this.runs.stopIssueRuns(actor, issueId, team.id);
    if (agentId && (await this.start(actor, ref, issueId, agentId)) === "needs_setup") await this.notices.needsSetup(actor, issue, ref);
  }

  /**
   * WH-118: an answer to an agent's question, from anyone on the team (a comment on the issue, whether it was typed there or in the
   * inbox), carries on each run that stopped with one: the same branch, as the person who requested it, with the answer in its brief.
   * With that person's device offline nothing starts and the issue stays asked; Rerun carries on from there.
   */
  @OnEvent(ISSUE_COMMENTED)
  async onCommented({ actor, issueId, ref, body }: IssueCommented) {
    if (actor.kind !== "human" || actor.system) return;
    const { issue, team } = await this.issues.resolveIssue(actor, issueId);
    if (!issue.delegateAgentId || !issue.delegatedAt) return;
    const since = issue.delegatedAt;
    const runs = (await this.repo.issueRuns(issueId, team.id)).map((r) => r.job).filter((j) => j.createdAt >= since);
    const latest = [...new Map([...runs].reverse().map((j) => [j.repositoryId, j])).values()];
    for (const job of latest.filter((j) => j.state === "succeeded" && typeof j.result?.question === "string")) {
      const name = (await this.repo.userName(job.createdBy!)) ?? "Wheelhouse";
      const requester: Actor = { kind: "human", id: job.createdBy!, name, workspaceId: job.workspaceId };
      await this.runs
        .runOnDevice(requester, ref, { deviceId: job.deviceId, repositoryId: job.repositoryId, baseBranch: job.baseBranch, model: job.model, continuesJobId: job.id, answer: body }, job.agentId ?? undefined)
        .catch((e) => this.log.warn(`${ref}: could not carry on after the answer: ${e instanceof Error ? e.message : e}`));
    }
  }

  /** WH-127: a requester who left the team or the workspace: their active runs stop and the issue's delegate is cleared. Returns how many. */
  async stopOrphaned() {
    const rows = await this.repo.orphanedRuns(ACTIVE);
    for (const { job } of rows) {
      await this.runs.stopIssueRuns({ kind: "human", id: job.createdBy!, name: "Wheelhouse", workspaceId: job.workspaceId }, job.issueId, job.teamId);
      await this.repo.clearDelegation(job.issueId);
    }
    return rows.length;
  }

  /** Delegated issues with no run yet, offered as their delegator. Returns how many started. */
  async offerWaiting() {
    let started = 0;
    for (const w of await this.repo.waitingDelegations()) {
      const actor: Actor = { kind: "human", id: w.delegatedBy!, name: w.name, workspaceId: w.workspaceId };
      const { issue, ref } = await this.issues.resolveIssue(actor, w.id).catch(() => ({ issue: null, ref: "" }));
      if (issue?.delegateAgentId && (await this.start(actor, ref, issue.id, issue.delegateAgentId).catch((e) => this.log.warn(`${ref}: ${e instanceof Error ? e.message : e}`))) === "started") started++;
    }
    return started;
  }

  /** Starts one run per target as the requester; otherwise says what is missing (the issue needs setup, or waits for a device). */
  private async start(actor: Actor, ref: string, issueId: string, agentId: string): Promise<"started" | "needs_setup" | "waiting"> {
    const planned = await this.planner.plan(actor, issueId, agentId);
    if ("missing" in planned) return planned.missing;
    for (const plan of planned.plans) await this.runs.runOnDevice(actor, ref, plan, agentId);
    return "started";
  }
}
