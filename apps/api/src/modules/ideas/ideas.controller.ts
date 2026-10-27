import { Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";
import { IdeasService } from "./ideas.service";

/** Ideas (WH-109): the workspace's, for every member but a guest. An idea of another workspace is a 404. */
@Controller("api/app/ideas")
@AppEndpoints()
export class IdeasController {
  constructor(@Inject(IdeasService) private readonly ideas: IdeasService) {}

  /** `{ ideas }`, newest first; `?status=` keeps one status. */
  @Get()
  async list(@Req() req: SessionRequest, @Query("status") status?: string) {
    return { ideas: await this.ideas.list(req.human.actor, status) };
  }

  /** `{ title, body?, team? }`; 201. */
  @Post()
  @HttpCode(201)
  async create(@Req() req: SessionRequest, @JsonBody() body: JsonObject) {
    return { idea: await this.ideas.create(req.human.actor, body) };
  }

  /** One idea with its comments and, once promoted, the issue it became. */
  @Get(":id")
  async one(@Req() req: SessionRequest, @Param("id") id: string) {
    return { idea: await this.ideas.get(req.human.actor, id) };
  }

  /** Any of `{ title, body, status, team, labels }` plus `version`, the one the edit started from (a stale one is a 409); `status` is new, exploring or parked. */
  @Patch(":id")
  async update(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return { idea: await this.ideas.update(req.human.actor, id, body) };
  }

  /** `{ body }` in Markdown; 201. */
  @Post(":id/comments")
  @HttpCode(201)
  async comment(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return { comment: await this.ideas.comment(req.human.actor, id, body.body) };
  }

  /** `{ team }` (the idea's own tag when absent): file it as an issue and mark it promoted. */
  @Post(":id/promote")
  async promote(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return { idea: await this.ideas.promote(req.human.actor, id, body) };
  }
}
