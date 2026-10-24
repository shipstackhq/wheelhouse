import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { IssuesService } from "../issues/index";
import { TeamAccessService } from "../teams/index";
import { ChecklistService } from "./checklist.service";
import { MetricsService } from "./metrics.service";

/**
 * One endpoint per dashboard widget, so each paints as soon as its own data arrives. All of them read the signed-in person's
 * workspace, limited to the teams they are in; with `?team=KEY` they read that one team instead.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(ChecklistService) private readonly checklist: ChecklistService,
    @Inject(IssuesService) private readonly issues: IssuesService,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
  ) {}

  /** The team page: the board and what hangs off it (the issues module) with the setup checklist. */
  async teamPage(actor: Actor, teamKey: string) {
    const [page, checklist] = await Promise.all([this.issues.boardPage(actor, teamKey), this.checklist.forTeam(actor, teamKey)]);
    return { page, checklist };
  }

  /** One widget's data. The team is resolved through requireTeam: another workspace's, or one the person is not in, is a plain 404. */
  async widget(actor: Actor, widget: string, team?: string) {
    if (team !== undefined && typeof team !== "string") throw new ServiceError("not_found", "Team not found"); // ?team=A&team=B
    const scoped = team ? (await this.access.require(actor, team)).id : undefined;
    const m = this.metrics;
    if (widget === "focus") {
      if (!scoped) throw new ServiceError("not_found", "That widget needs a team");
      return m.teamFocus(actor, scoped);
    }
    switch (widget) {
      case "kpis":
        return m.summary(actor, scoped);
      case "progress":
        return m.teamProgress(actor, scoped);
      case "throughput":
        return m.throughput(actor, 14, scoped);
      case "activity-split":
        return m.activityByActor(actor, 14, scoped);
      case "agents":
        return m.agentQueues(actor, scoped);
      case "attention":
        return m.needsAttention(actor, scoped);
      case "recent":
        // Only what the row shows: the raw event also carries ids and internals the page has no use for.
        return (await m.recentActivity(actor, 25, scoped)).map((e) => ({ seq: e.seq, teamKey: e.teamKey, actorKind: e.actorKind, actorName: e.actorName, summary: e.summary, createdAt: e.createdAt }));
      case "sync":
        return m.syncHealth(actor, scoped);
      default:
        throw new ServiceError("not_found", "Unknown dashboard widget");
    }
  }
}
