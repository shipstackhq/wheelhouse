import { Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { createProject, listProjects, removeSession } from "@wheelhouse/core/lib/service";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

const view = (p: { id: string; key: string; name: string; description: string; createdAt: Date }) => ({ id: p.id, key: p.key, name: p.name, description: p.description, createdAt: p.createdAt });

@Controller("api/app/projects")
@AppEndpoints()
export class ProjectsController {
  /** The team's projects, oldest first. The team is the signed-in person's own; it is never taken from the request. */
  @Get()
  @UseGuards(SessionGuard)
  async list(@Req() req: SessionRequest) {
    return { projects: (await listProjects(req.human.actor)).map(view) };
  }

  /** `{ name, key?, description? }`. The key defaults from the name. 201 with the project; a taken key is a 409. */
  @Post()
  @UseGuards(SessionGuard)
  @HttpCode(201)
  async create(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return { project: view(await createProject(req.human.actor, { name: str(b.name), key: str(b.key) || undefined, description: str(b.description) })) };
  }

  /** Teammates remove an agent session from a project (soft delete: if it reconnects it starts at the top of the queue). */
  @Delete(":key/sessions/:sessionId")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  removeSession(@Req() req: SessionRequest, @Param("key") key: string, @Param("sessionId") sessionId: string) {
    return removeSession(req.human.actor, key, sessionId);
  }
}
