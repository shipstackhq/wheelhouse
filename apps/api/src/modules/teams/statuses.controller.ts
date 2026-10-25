import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";

import { StatusesService } from "./statuses.service";

import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { reorderStatusesDto, statusBodyDto, type ReorderStatusesDto, type StatusBodyDto } from "./dto/teams.dto";


/**
 * A team's statuses, as its settings page edits them. Anyone on the team can read them; changing them is for team admins (403
 * otherwise), and for people only. A team of another workspace, or one the person is not on, is a 404.
 */
@Controller("api/app/teams")
@AppEndpoints()
export class StatusesController {
  constructor(@Inject(StatusesService) private readonly statuses: StatusesService) {}

  /** The team's statuses in board order, each with its role, whether it is its role's default, its colour and how many issues are in it. */
  @Get(":key/statuses")
  async list(@Req() req: SessionRequest, @Param("key") key: string) {
    return { statuses: await this.statuses.list(req.human.actor, key) };
  }

  /** `{ name, role, color? }`: a new status at the end of its role's group; the first of a role is its default. 201 with the status; a taken name is a 409. */
  @Post(":key/statuses")
  @HttpCode(201)
  async create(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody(new ZodValidationPipe(statusBodyDto)) body: StatusBodyDto) {
    return { status: await this.statuses.create(req.human.actor, key, body) };
  }

  /** `{ ids }`: every status of the team in the order wanted. Roles must stay grouped in their order. Answers the list. */
  @Put(":key/statuses/order")
  async order(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody(new ZodValidationPipe(reorderStatusesDto)) body: ReorderStatusesDto) {
    return { statuses: await this.statuses.reorder(req.human.actor, key, body.ids) };
  }

  /** `{ name?, color?, isDefault? }`: `isDefault` only as true. A role cannot change (400). The status is an id or a name. */
  @Patch(":key/statuses/:id")
  async update(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string, @JsonBody(new ZodValidationPipe(statusBodyDto)) body: StatusBodyDto) {
    return { status: await this.statuses.update(req.human.actor, key, id, body) };
  }

  /** `?moveTo=<id or name>`: where its issues go, needed when it has any (409 with their count otherwise). The last status of a required role stays (409). */
  @Delete(":key/statuses/:id")
  async remove(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string, @Query("moveTo") moveTo?: string) {
    return this.statuses.delete(req.human.actor, key, id, moveTo || null);
  }
}
