import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";

import { TeamsService } from "./teams.service";

import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { SessionGuard, type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { addMemberDto, setMemberRoleDto, type AddMemberDto, type SetMemberRoleDto } from "./dto/teams.dto";


/**
 * Who is in a team, and the workspace-level views of access (ADR-23). Every rule (who may, the last admin, the audit line)
 * lives in core; this only reads the request and hands the signed-in person over.
 */
@Controller("api/app")
@AppEndpoints()
@UseGuards(SessionGuard)
export class TeamMembersController {
  constructor(@Inject(TeamsService) private readonly teams: TeamsService) {}

  /** The team's members and the caller's own role in it. Any member may read it. */
  @Get("teams/:key/members")
  list(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.teams.listTeamMembers(req.human.actor, key);
  }

  /** Workspace members not yet in the team (team admins). */
  @Get("teams/:key/members/addable")
  async addable(@Req() req: SessionRequest, @Param("key") key: string) {
    return { people: await this.teams.listAddableMembers(req.human.actor, key) };
  }

  /** `{ userId, role }` with role admin, editor or viewer. 201; someone already in is a 409. */
  @Post("teams/:key/members")
  @HttpCode(201)
  async add(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody(new ZodValidationPipe(addMemberDto)) body: AddMemberDto) {
    return { member: await this.teams.addTeamMember(req.human.actor, key, body) };
  }

  /** `{ role }`. The last admin cannot be demoted (409). */
  @Patch("teams/:key/members/:userId")
  async setRole(@Req() req: SessionRequest, @Param("key") key: string, @Param("userId") userId: string, @JsonBody(new ZodValidationPipe(setMemberRoleDto)) body: SetMemberRoleDto) {
    return { member: await this.teams.setTeamMemberRole(req.human.actor, key, userId, body.role) };
  }

  /** Remove someone, or leave yourself. The last admin cannot go (409). */
  @Delete("teams/:key/members/:userId")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("key") key: string, @Param("userId") userId: string) {
    return this.teams.removeTeamMember(req.human.actor, key, userId);
  }

  /** A workspace owner or admin joins the team as its admin. Audited, and shown in the team's activity. */
  @Post("teams/:key/join")
  @HttpCode(200)
  join(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.teams.joinTeamAsWorkspaceAdmin(req.human.actor, key);
  }

  /** Every team of the workspace by name, with its admins and whether you are in it (owners and admins). */
  @Get("access/teams")
  async workspaceTeams(@Req() req: SessionRequest) {
    return { teams: await this.teams.listWorkspaceTeams(req.human.actor) };
  }

  /** The access audit log, newest first (owners and admins). `?team=KEY` narrows it; `?limit=` up to 500. */
  @Get("access/audit")
  async audit(@Req() req: SessionRequest, @Query("team") team?: string, @Query("limit") limit?: string) {
    return { events: await this.teams.listAudit(req.human.actor, { teamRef: team || undefined, limit: limit ? Number(limit) : undefined }) };
  }
}
