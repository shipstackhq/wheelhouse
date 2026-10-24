import { Controller, Get, Inject, Param, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { boardView } from "../issues/index";
import { DashboardService } from "./dashboard.service";

@Controller("api/app/teams")
@AppEndpoints()
export class TeamPageController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  /** The team page in one read: statuses, issues, the map nodes an issue can link to, the workspace's members, cycles, projects and the setup checklist. */
  @Get(":key/board")
  async board(@Req() req: SessionRequest, @Param("key") key: string) {
    const { page, checklist } = await this.dashboard.teamPage(req.human.actor, key);
    return { ...boardView(page), checklist };
  }
}
