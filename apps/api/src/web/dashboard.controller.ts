import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import * as m from "@wheelhouse/core/lib/metrics";
import { ServiceError } from "@wheelhouse/core/lib/service";
import type { Actor } from "@wheelhouse/core/lib/access";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/** One endpoint per dashboard widget, so each paints as soon as its own data arrives. All of them read the signed-in person's team. */
const WIDGETS: Record<string, (actor: Actor) => Promise<unknown>> = {
  kpis: m.summary,
  progress: m.projectProgress,
  throughput: (a) => m.throughput(a, 14),
  "activity-split": (a) => m.activityByActor(a, 14),
  agents: m.agentQueues,
  attention: m.needsAttention,
  // Only what the row shows: the raw event also carries ids and internals the page has no use for.
  recent: async (a) =>
    (await m.recentActivity(a, 25)).map((e) => ({ seq: e.seq, projectKey: e.projectKey, actorKind: e.actorKind, actorName: e.actorName, summary: e.summary, createdAt: e.createdAt })),
  sync: m.syncHealth,
};

@Controller("api/app/dashboard")
@AppEndpoints()
@UseGuards(SessionGuard)
export class DashboardController {
  @Get(":widget")
  async widget(@Req() req: SessionRequest, @Param("widget") widget: string) {
    const load = Object.hasOwn(WIDGETS, widget) ? WIDGETS[widget] : null;
    if (!load) throw new ServiceError("not_found", "Unknown dashboard widget");
    return load(req.human.actor);
  }
}
