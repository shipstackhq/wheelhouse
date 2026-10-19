import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import * as m from "@wheelhouse/core/lib/metrics";
import { getProject, ServiceError } from "@wheelhouse/core/lib/service";
import type { Actor } from "@wheelhouse/core/lib/access";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/**
 * One endpoint per dashboard widget, so each paints as soon as its own data arrives. All of them read the signed-in person's
 * workspace, limited to the projects they are in; with `?project=KEY` they read that one project instead.
 */
type Load = (actor: Actor, projectId?: string) => Promise<unknown>;
const WIDGETS: Record<string, Load> = {
  kpis: m.summary,
  progress: m.projectProgress,
  throughput: (a, p) => m.throughput(a, 14, p),
  "activity-split": (a, p) => m.activityByActor(a, 14, p),
  agents: m.agentQueues,
  attention: m.needsAttention,
  // Only what the row shows: the raw event also carries ids and internals the page has no use for.
  recent: async (a, p) =>
    (await m.recentActivity(a, 25, p)).map((e) => ({ seq: e.seq, projectKey: e.projectKey, actorKind: e.actorKind, actorName: e.actorName, summary: e.summary, createdAt: e.createdAt })),
  sync: m.syncHealth,
};
/** Widgets that only make sense for one project: they need `?project=KEY`. */
const PROJECT_ONLY: Record<string, (actor: Actor, projectId: string) => Promise<unknown>> = {
  focus: m.projectFocus,
};

@Controller("api/app/dashboard")
@AppEndpoints()
@UseGuards(SessionGuard)
export class DashboardController {
  @Get(":widget")
  async widget(@Req() req: SessionRequest, @Param("widget") widget: string, @Query("project") project?: string) {
    // The project is resolved through getProject: another workspace's, or one the person is not in, is a plain 404.
    if (project !== undefined && typeof project !== "string") throw new ServiceError("not_found", "Project not found"); // ?project=A&project=B
    const scoped = project ? (await getProject(req.human.actor, project)).id : undefined;
    if (Object.hasOwn(PROJECT_ONLY, widget)) {
      if (!scoped) throw new ServiceError("not_found", "That widget needs a project");
      return PROJECT_ONLY[widget](req.human.actor, scoped);
    }
    const load = Object.hasOwn(WIDGETS, widget) ? WIDGETS[widget] : null;
    if (!load) throw new ServiceError("not_found", "Unknown dashboard widget");
    return load(req.human.actor, scoped);
  }
}
