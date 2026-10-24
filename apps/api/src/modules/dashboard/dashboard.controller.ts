import { Controller, Get, Inject, Param, Query, Req, UseGuards } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { SessionGuard, type SessionRequest } from "../../common/guards/session.guard";
import { DashboardService } from "./dashboard.service";

/**
 * One endpoint per dashboard widget, so each paints as soon as its own data arrives. All of them read the signed-in person's
 * workspace, limited to the teams they are in; with `?team=KEY` they read that one team instead.
 */
@Controller("api/app/dashboard")
@AppEndpoints()
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get(":widget")
  widget(@Req() req: SessionRequest, @Param("widget") widget: string, @Query("team") team?: string) {
    return this.dashboard.widget(req.human.actor, widget, team);
  }
}
