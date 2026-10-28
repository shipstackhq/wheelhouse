import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { effectiveProfile } from "../agents/index";
import { IssueTargets } from "../issues/index";
import { DaemonRepository } from "./daemon.repository";
import { DevicesService } from "./devices.service";

/** A reviewer agent (WH-122) looks at a pull request instead of working on targets. */
export const isReviewer = (agent: { catalogSlug: string | null } | undefined) => agent?.catalogSlug === "reviewer";

export type RunPlan = { deviceId: string; repositoryId: string; baseBranch: string; model: string; effort: "low" | "medium" | "high" | null; fellBack: boolean };

/** What stops a delegation from starting: its targets are not settled (a person must say where), or none of the requester's devices is online (it waits). */
export type PlanResult = { plans: RunPlan[] } | { missing: "needs_setup" | "waiting" };

/**
 * WH-131: the one place that decides where and how a delegated run happens, so Delegate, Rerun, a confirmed setup and the waiting sweep
 * all produce the same plan for the same issue. Repository and base branch come only from the issue's targets (an agent never picks
 * where to work); one run per target. Each setting takes the first of: the agent profile's, the requester's own default (WH-123), then
 * what is inferred. Device: the default if online, else the one last used if online, else any online (`fellBack` says the default was
 * offline). Model: the pinned one if the device offers it, else the default, else sonnet, else the device's first. Effort: the profile's,
 * else the default, else Claude's own.
 */
@Injectable()
export class RunPlanner {
  constructor(
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(IssueTargets) private readonly targets: IssueTargets,
  ) {}

  async plan(requester: Actor, issueId: string, agentId: string | null): Promise<PlanResult> {
    const agent = agentId ? await this.repo.workspaceAgent(agentId, requester.workspaceId) : undefined;
    // A reviewer works on the issue's open pull request, wherever it is; with none yet, it waits for one.
    const pr = isReviewer(agent) ? await this.repo.openPullRequestOf(issueId) : undefined;
    const { targets } = pr ? { targets: [{ repositoryId: pr.repositoryId, baseBranch: pr.headBranch }] } : await this.targets.of(issueId);
    if (isReviewer(agent) && !pr) return { missing: "waiting" };
    if (!targets.length) return { missing: "needs_setup" };
    const online = (await this.devices.listDevices(requester)).filter((d) => d.status === "online");
    if (!online.length) return { missing: "waiting" };
    const defaults = await this.repo.runDefaults(requester.id);
    const last = await this.repo.lastRunDevice(requester.id);
    const device = online.find((d) => d.id === defaults?.deviceId) ?? online.find((d) => d.id === last) ?? online[0];
    const fellBack = !!defaults?.deviceId && device.id !== defaults.deviceId;
    const profile = agent ? effectiveProfile(agent) : null;
    const model = [profile?.model ?? "inherit", defaults?.model, "sonnet"].find((m) => m && m !== "inherit" && device.models.includes(m)) ?? device.models[0];
    const effort = profile?.effort ?? defaults?.effort ?? null;
    return { plans: targets.map((t) => ({ deviceId: device.id, repositoryId: t.repositoryId, baseBranch: t.baseBranch, model, effort, fellBack })) };
  }
}
