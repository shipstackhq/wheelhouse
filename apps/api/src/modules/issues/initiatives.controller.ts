import { Controller, Inject, Delete, Get, Param, Patch, Post, Req } from "@nestjs/common";
import { IssuesService } from "./issues.service";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";

/**
 * Initiatives (WH-119): goals that group projects and other initiatives, up to three levels. They belong to the workspace and every
 * member except a guest sees them; the projects of teams the caller is not on show only as totals. An initiative that is not
 * visible to the caller is a 404, the same as one that does not exist.
 */
@Controller("api/app/initiatives")
@AppEndpoints()
export class InitiativesController {
  constructor(@Inject(IssuesService) private readonly issues: IssuesService) {}

  /** `{ initiatives }`: every one, parents before their children, each with its roll-up progress and health. */
  @Get()
  async list(@Req() req: SessionRequest) {
    return { initiatives: await this.issues.listInitiativesAs(req.human.actor) };
  }

  /** `{ name, description?, status?, targetDate?, owner?, parentId?, healthOverride? }`; 201. Viewers cannot create. */
  @Post()
  async create(@Req() req: SessionRequest, @JsonBody() body: JsonObject) {
    return { initiative: await this.issues.createInitiativeAs(req.human.actor, body) };
  }

  /** One initiative: its path, sub-initiatives, the projects of the viewer's teams and the totals of the rest. */
  @Get(":id")
  async one(@Req() req: SessionRequest, @Param("id") id: string) {
    return { initiative: await this.issues.getInitiativeAs(req.human.actor, id) };
  }

  /** Any create field, `healthOverride: null` to clear it, `parentId` (null for the top) and `index` to move it, and `version` for the lock. */
  @Patch(":id")
  async update(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return { initiative: await this.issues.updateInitiativeAs(req.human.actor, id, body) };
  }

  /** Soft delete: its sub-initiatives move up, its links go, the projects stay. */
  @Delete(":id")
  async remove(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.issues.deleteInitiativeAs(req.human.actor, id);
  }

  /** `{ projectId }`: group a project you can see. */
  @Post(":id/projects")
  async link(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return { initiative: await this.issues.linkProjectAs(req.human.actor, id, body) };
  }

  /** The project and its issues are untouched. */
  @Delete(":id/projects/:projectId")
  async unlink(@Req() req: SessionRequest, @Param("id") id: string, @Param("projectId") projectId: string) {
    return { initiative: await this.issues.unlinkProjectAs(req.human.actor, id, projectId) };
  }
}
