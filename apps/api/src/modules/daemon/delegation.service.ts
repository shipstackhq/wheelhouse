import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { Actor } from "../../common/actor";
import { ISSUE_DELEGATED, IssuesService, type IssueDelegated } from "../issues/index";
import { effectiveProfile } from "../agents/index";
import { DaemonRepository } from "./daemon.repository";
import { DevicesService } from "./devices.service";
import { RunsService } from "./runs.service";

/** How often issues waiting for a device are offered again. */
const WAITING_EVERY_MS = 30_000;

/**
 * WH-116: delegating an issue starts a run, clearing (or changing) the delegate stops the active one. The run is the delegator's: on
 * the device they last ran on if it is online, else any of their online devices. With none online the issue waits, and is offered when
 * one comes back. The api role's side; a failure here is logged and never undoes the delegation.
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
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.offerWaiting().catch((e) => this.log.warn(`offering waiting delegations failed: ${e instanceof Error ? e.message : e}`)), WAITING_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  @OnEvent(ISSUE_DELEGATED)
  async onDelegated({ actor, issueId, ref, agentId }: IssueDelegated) {
    const { team } = await this.issues.resolveIssue(actor, issueId);
    await this.runs.stopIssueRuns(actor, issueId, team.id);
    if (agentId) await this.start(actor, ref, issueId, agentId);
  }

  /** Delegated issues with no run yet, offered as their delegator. Returns how many started. */
  async offerWaiting() {
    let started = 0;
    for (const w of await this.repo.waitingDelegations()) {
      const actor: Actor = { kind: "human", id: w.delegatedBy!, name: w.name, workspaceId: w.workspaceId };
      const { issue, ref } = await this.issues.resolveIssue(actor, w.id).catch(() => ({ issue: null, ref: "" }));
      if (issue?.delegateAgentId && (await this.start(actor, ref, issue.id, issue.delegateAgentId).catch((e) => this.log.warn(`${ref}: ${e instanceof Error ? e.message : e}`)))) started++;
    }
    return started;
  }

  /** Starts the run on one of the delegator's online devices; false when none is online (the issue waits). */
  private async start(actor: Actor, ref: string, issueId: string, agentId: string): Promise<boolean> {
    const online = (await this.devices.listDevices(actor)).filter((d) => d.status === "online");
    if (!online.length) return false;
    const last = await this.repo.lastRunDevice(actor.id);
    const device = online.find((d) => d.id === last) ?? online[0];
    // The repository of the issue's last run, so a delegated rerun works where the earlier one did; otherwise the team's only one.
    const { team } = await this.issues.resolveIssue(actor, issueId);
    const previous = (await this.repo.issueRuns(issueId, team.id)).find((r) => r.job.repositoryId)?.job.repositoryId ?? undefined;
    const agent = await this.repo.workspaceAgent(agentId, actor.workspaceId);
    const pinned = agent ? effectiveProfile(agent).model : "inherit";
    const model = [pinned, "sonnet"].find((m) => m !== "inherit" && device.models.includes(m)) ?? device.models[0];
    await this.runs.runOnDevice(actor, ref, { deviceId: device.id, repositoryId: previous, model }, agentId);
    return true;
  }
}
