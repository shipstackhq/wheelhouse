import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";

import { ServiceError } from "../../common/service-error";
import { TeamsService } from "./teams.service";

import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { createTeamDto, setOrderDto, setParentDto, updateTeamDto, type CreateTeamDto, type SetOrderDto, type SetParentDto, type UpdateTeamDto } from "./dto/teams.dto";


const view = (p: { id: string; key: string; name: string; description: string; createdAt: Date; icon?: string | null; iconColor?: string | null; role?: string; retiredAt?: Date | null; parentId?: string | null }) => ({ id: p.id, key: p.key, name: p.name, description: p.description, createdAt: p.createdAt, icon: p.icon ?? null, iconColor: p.iconColor ?? null, retired: !!p.retiredAt, parentId: p.parentId ?? null, ...(p.role ? { role: p.role } : {}) });

@Controller("api/app/teams")
@AppEndpoints()
export class TeamsController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  /** The person's teams, in the order they keep them (oldest first until they reorder). The workspace is the signed-in person's own; it is never taken from the request. */
  @Get()
  async list(@Req() req: SessionRequest) {
    return { teams: (await this.teams.listTeamsWithRole(req.human.actor)).map(view) };
  }

  /** `{ keys }`: the order this person keeps their teams in, first to last. Theirs alone; the list above comes back in it. */
  @Put("order")
  async order(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(setOrderDto)) body: SetOrderDto) {
    return this.teams.setTeamOrder(req.human.actor, body.keys);
  }

  /** `{ name, key?, description? }`. The key defaults from the name. 201 with the team; a taken key is a 409. */
  @Post()
  @HttpCode(201)
  async create(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(createTeamDto)) body: CreateTeamDto) {
    return { team: view(await this.teams.createTeam(req.human.actor, body)) };
  }

  /** The teams you can open that could be the parent of a team being created. */
  @Get("parent-candidates")
  async newParentCandidates(@Req() req: SessionRequest) {
    return { teams: await this.teams.parentCandidates(req.human.actor) };
  }

  /** The teams you can open that could be this team's parent: not itself, not its descendants. Team admins. */
  @Get(":key/parent-candidates")
  async parentOptions(@Req() req: SessionRequest, @Param("key") key: string) {
    return { teams: await this.teams.parentCandidates(req.human.actor, key) };
  }

  /** Team settings read: parent, children, and `canLeave` / `canRetire` / `canDelete`, each `{ allowed, reason }`. */
  @Get(":key/settings")
  settings(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.teams.getTeamSettings(req.human.actor, key);
  }

  /** `{ parent }`: a team key, or null to make the team top-level. Admin of the team, who must be able to open the parent. Cycles are a 400. */
  @Put(":key/parent")
  async setParent(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody(new ZodValidationPipe(setParentDto)) body: SetParentDto) {
    return { team: view(await this.teams.setTeamParent(req.human.actor, key, body.parent)) };
  }

  /** Retire the team (admins). The last active team, a project lead and a team with active children are a 409. */
  @Post(":key/retire")
  @HttpCode(200)
  async retire(@Req() req: SessionRequest, @Param("key") key: string) {
    return { team: view(await this.teams.retireTeam(req.human.actor, key)) };
  }

  /** Restore a retired team (admins of it). */
  @Post(":key/restore")
  @HttpCode(200)
  async restore(@Req() req: SessionRequest, @Param("key") key: string) {
    return { team: view(await this.teams.restoreTeam(req.human.actor, key)) };
  }

  /** `?confirm=KEY`: the team key, typed (a DELETE's body is not read, see raw-text.ts). Deletes the team and everything in it (admins). */
  @Delete(":key")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("key") key: string, @Query("confirm") confirm?: string) {
    if (typeof confirm !== "string" || confirm.trim().toUpperCase() !== key.toUpperCase()) throw new ServiceError("invalid", "Type the team key to confirm the delete");
    return this.teams.deleteTeam(req.human.actor, key);
  }

  /** `{ name?, description?, icon?, iconColor? }`: team settings. `icon` is `ri:<name>` or one emoji, `null` clears it. Team admins only (403 otherwise); the key does not change. */
  @Patch(":key")
  async update(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody(new ZodValidationPipe(updateTeamDto)) body: UpdateTeamDto) {
    return { team: view(await this.teams.updateTeam(req.human.actor, key, body)) };
  }

  /** Teammates remove an agent session from a team (soft delete: if it reconnects it starts at the top of the queue). */
  @Delete(":key/sessions/:sessionId")
  @HttpCode(200)
  removeSession(@Req() req: SessionRequest, @Param("key") key: string, @Param("sessionId") sessionId: string) {
    return this.teams.removeSession(req.human.actor, key, sessionId);
  }
}
