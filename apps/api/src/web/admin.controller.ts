import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { isInstanceAdmin } from "@wheelhouse/core/lib/auth-policy";
import { ServiceError } from "@wheelhouse/core/lib/service";
import { getTeamDetail, listTeams, restoreTeam, suspendTeam, type Admin } from "@wheelhouse/core/lib/teams-admin";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

const adminOf = (req: SessionRequest): Admin => ({ userId: req.human.user.id, email: req.human.user.email, teamId: req.human.team.id });

/** For anyone who is not an instance admin these pages do not exist: a 404, as the pages themselves always said. */
function onlyAdmins(req: SessionRequest) {
  if (!isInstanceAdmin(req.human.user.email)) throw new ServiceError("not_found", "Not found");
}

@Controller("api/app/admin")
@AppEndpoints()
@UseGuards(SessionGuard)
export class AdminController {
  /** Every team on this server: names, emails and counts only, never what a team wrote. */
  @Get("teams")
  async teams(@Req() req: SessionRequest) {
    onlyAdmins(req);
    return { teams: await listTeams(adminOf(req)) };
  }

  @Get("teams/:id")
  async team(@Req() req: SessionRequest, @Param("id") id: string) {
    onlyAdmins(req);
    return { team: await getTeamDetail(adminOf(req), id) };
  }

  /** `{ confirm, reason? }`: the team's exact name must be typed. Signs its members out; reversible. */
  @Post("teams/:id/suspend")
  @HttpCode(200)
  async suspend(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    onlyAdmins(req);
    const b = jsonBody(req);
    return suspendTeam(adminOf(req), id, { confirmName: str(b.confirm), reason: str(b.reason) });
  }

  @Post("teams/:id/restore")
  @HttpCode(200)
  async restore(@Req() req: SessionRequest, @Param("id") id: string) {
    onlyAdmins(req);
    await restoreTeam(adminOf(req), id);
    return { ok: true };
  }
}
