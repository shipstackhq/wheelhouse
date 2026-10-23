import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { createStatus, deleteStatus, listStatuses, reorderStatuses, updateStatus } from "../lib/statuses";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/**
 * A team's statuses, as its settings page edits them. Anyone on the team can read them; changing them is for team admins (403
 * otherwise), and for people only. A team of another workspace, or one the person is not on, is a 404.
 */
@Controller("api/app/teams")
@AppEndpoints()
@UseGuards(SessionGuard)
export class StatusesController {
  /** The team's statuses in board order, each with its role, whether it is its role's default, its colour and how many issues are in it. */
  @Get(":key/statuses")
  async list(@Req() req: SessionRequest, @Param("key") key: string) {
    return { statuses: await listStatuses(req.human.actor, key) };
  }

  /** `{ name, role, color? }`: a new status at the end of its role's group; the first of a role is its default. 201 with the status; a taken name is a 409. */
  @Post(":key/statuses")
  @HttpCode(201)
  async create(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { status: await createStatus(req.human.actor, key, jsonBody(req)) };
  }

  /** `{ ids }`: every status of the team in the order wanted. Roles must stay grouped in their order. Answers the list. */
  @Put(":key/statuses/order")
  async order(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { statuses: await reorderStatuses(req.human.actor, key, jsonBody(req).ids) };
  }

  /** `{ name?, color?, isDefault? }`: `isDefault` only as true. A role cannot change (400). The status is an id or a name. */
  @Patch(":key/statuses/:id")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string, @Param("id") id: string) {
    return { status: await updateStatus(req.human.actor, key, id, jsonBody(req)) };
  }

  /** `?moveTo=<id or name>`: where its issues go, needed when it has any (409 with their count otherwise). The last status of a required role stays (409). */
  @Delete(":key/statuses/:id")
  async remove(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string, @Query("moveTo") moveTo?: string) {
    return deleteStatus(req.human.actor, key, id, moveTo || null);
  }
}
