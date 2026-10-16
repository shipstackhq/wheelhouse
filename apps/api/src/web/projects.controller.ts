import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { listProjects } from "@wheelhouse/core/lib/service";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

@Controller("api/app/projects")
@AppEndpoints()
export class ProjectsController {
  /** The team's projects, oldest first. The team is the signed-in person's own; it is never taken from the request. */
  @Get()
  @UseGuards(SessionGuard)
  async list(@Req() req: SessionRequest) {
    const rows = await listProjects(req.human.actor);
    return { projects: rows.map((p) => ({ id: p.id, key: p.key, name: p.name, description: p.description, createdAt: p.createdAt })) };
  }
}
