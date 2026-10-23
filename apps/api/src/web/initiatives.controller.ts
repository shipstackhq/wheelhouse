import { Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import {
  createInitiativeAs,
  deleteInitiativeAs,
  getInitiativeAs,
  linkProjectAs,
  listInitiativesAs,
  unlinkProjectAs,
  updateInitiativeAs,
} from "../lib/initiatives-app";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/**
 * Initiatives (WH-119): goals that group projects and other initiatives, up to three levels. They belong to the workspace and every
 * member except a guest sees them; the projects of teams the caller is not on show only as totals. An initiative that is not
 * visible to the caller is a 404, the same as one that does not exist.
 */
@Controller("api/app/initiatives")
@AppEndpoints()
@UseGuards(SessionGuard)
export class InitiativesController {
  /** `{ initiatives }`: every one, parents before their children, each with its roll-up progress and health. */
  @Get()
  async list(@Req() req: SessionRequest) {
    return { initiatives: await listInitiativesAs(req.human.actor) };
  }

  /** `{ name, description?, status?, targetDate?, owner?, parentId?, healthOverride? }`; 201. Viewers cannot create. */
  @Post()
  async create(@Req() req: SessionRequest & RawTextRequest) {
    return { initiative: await createInitiativeAs(req.human.actor, jsonBody(req)) };
  }

  /** One initiative: its path, sub-initiatives, the projects of the viewer's teams and the totals of the rest. */
  @Get(":id")
  async one(@Req() req: SessionRequest, @Param("id") id: string) {
    return { initiative: await getInitiativeAs(req.human.actor, id) };
  }

  /** Any create field, `healthOverride: null` to clear it, `parentId` (null for the top) and `index` to move it, and `version` for the lock. */
  @Patch(":id")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    return { initiative: await updateInitiativeAs(req.human.actor, id, jsonBody(req)) };
  }

  /** Soft delete: its sub-initiatives move up, its links go, the projects stay. */
  @Delete(":id")
  async remove(@Req() req: SessionRequest, @Param("id") id: string) {
    return deleteInitiativeAs(req.human.actor, id);
  }

  /** `{ projectId }`: group a project you can see. */
  @Post(":id/projects")
  async link(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    return { initiative: await linkProjectAs(req.human.actor, id, jsonBody(req)) };
  }

  /** The project and its issues are untouched. */
  @Delete(":id/projects/:projectId")
  async unlink(@Req() req: SessionRequest, @Param("id") id: string, @Param("projectId") projectId: string) {
    return { initiative: await unlinkProjectAs(req.human.actor, id, projectId) };
  }
}
