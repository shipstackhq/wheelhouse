import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import * as m from "../lib/metrics";
import { requireTeam, ServiceError } from "../lib/service";
import type { Actor } from "../common/actor";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/**
 * One endpoint per dashboard widget, so each paints as soon as its own data arrives. All of them read the signed-in person's
 * workspace, limited to the teams they are in; with `?team=KEY` they read that one team instead.
 */
type Load = (actor: Actor, teamId?: string) => Promise<unknown>;
const WIDGETS: Record<string, Load> = {
  kpis: m.summary,
  progress: m.teamProgress,
  throughput: (a, p) => m.throughput(a, 14, p),
  "activity-split": (a, p) => m.activityByActor(a, 14, p),
  agents: m.agentQueues,
  attention: m.needsAttention,
  // Only what the row shows: the raw event also carries ids and internals the page has no use for.
  recent: async (a, p) =>
    (await m.recentActivity(a, 25, p)).map((e) => ({ seq: e.seq, teamKey: e.teamKey, actorKind: e.actorKind, actorName: e.actorName, summary: e.summary, createdAt: e.createdAt })),
  sync: m.syncHealth,
};
/** Widgets that only make sense for one team: they need `?team=KEY`. */
const TEAM_ONLY: Record<string, (actor: Actor, teamId: string) => Promise<unknown>> = {
  focus: m.teamFocus,
};

@Controller("api/app/dashboard")
@AppEndpoints()
@UseGuards(SessionGuard)
export class DashboardController {
  @Get(":widget")
  async widget(@Req() req: SessionRequest, @Param("widget") widget: string, @Query("team") team?: string) {
    // The team is resolved through requireTeam: another workspace's, or one the person is not in, is a plain 404.
    if (team !== undefined && typeof team !== "string") throw new ServiceError("not_found", "Team not found"); // ?team=A&team=B
    const scoped = team ? (await requireTeam(req.human.actor, team)).id : undefined;
    if (Object.hasOwn(TEAM_ONLY, widget)) {
      if (!scoped) throw new ServiceError("not_found", "That widget needs a team");
      return TEAM_ONLY[widget](req.human.actor, scoped);
    }
    const load = Object.hasOwn(WIDGETS, widget) ? WIDGETS[widget] : null;
    if (!load) throw new ServiceError("not_found", "Unknown dashboard widget");
    return load(req.human.actor, scoped);
  }
}
