import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { LearningsService } from "./learnings.service";

/** WH-124: what a team has taught one of its agents (`/api/app/teams/:team/agents/:slug/learnings`). */
@Controller("api/app/teams/:team/agents/:slug/learnings")
@AppEndpoints()
export class LearningsController {
  constructor(@Inject(LearningsService) private readonly learnings: LearningsService) {}

  @Get()
  list(@Req() req: SessionRequest, @Param("team") team: string, @Param("slug") slug: string) {
    return this.learnings.list(req.human.actor, team, slug);
  }

  @Patch(":id")
  update(@Req() req: SessionRequest, @Param("team") team: string, @Param("slug") slug: string, @Param("id") id: string, @Body() body: { note?: unknown }) {
    return this.learnings.update(req.human.actor, team, slug, id, body?.note);
  }

  @Delete(":id")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("team") team: string, @Param("slug") slug: string, @Param("id") id: string) {
    return this.learnings.remove(req.human.actor, team, slug, id);
  }
}
