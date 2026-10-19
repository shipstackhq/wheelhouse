import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { listProjectsWithRole } from "@wheelhouse/core/lib/project-members";
import { createProject, removeSession, updateProject } from "@wheelhouse/core/lib/service";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

const view = (p: { id: string; key: string; name: string; description: string; createdAt: Date; role?: string }) => ({ id: p.id, key: p.key, name: p.name, description: p.description, createdAt: p.createdAt, ...(p.role ? { role: p.role } : {}) });

@Controller("api/app/projects")
@AppEndpoints()
export class ProjectsController {
  /** The team's projects, oldest first. The team is the signed-in person's own; it is never taken from the request. */
  @Get()
  @UseGuards(SessionGuard)
  async list(@Req() req: SessionRequest) {
    return { projects: (await listProjectsWithRole(req.human.actor)).map(view) };
  }

  /** `{ name, key?, description? }`. The key defaults from the name. 201 with the project; a taken key is a 409. */
  @Post()
  @UseGuards(SessionGuard)
  @HttpCode(201)
  async create(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return { project: view(await createProject(req.human.actor, { name: str(b.name), key: str(b.key) || undefined, description: str(b.description) })) };
  }

  /** `{ name?, description? }`: project settings. Project admins only (403 otherwise); the key does not change. */
  @Patch(":key")
  @UseGuards(SessionGuard)
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    const b = jsonBody(req);
    return { project: view(await updateProject(req.human.actor, key, { name: typeof b.name === "string" ? b.name : undefined, description: typeof b.description === "string" ? b.description : undefined })) };
  }

  /** Teammates remove an agent session from a project (soft delete: if it reconnects it starts at the top of the queue). */
  @Delete(":key/sessions/:sessionId")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  removeSession(@Req() req: SessionRequest, @Param("key") key: string, @Param("sessionId") sessionId: string) {
    return removeSession(req.human.actor, key, sessionId);
  }
}
