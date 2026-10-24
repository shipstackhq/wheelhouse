import { Controller, Inject, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { isInstanceAdmin } from "./auth-policy";
import { ServiceError } from "../../common/service-error";
import { type Admin } from "./workspaces-admin";
import type { RawTextRequest } from "../../http/raw-text";
import { jsonBody, str } from "../../web/body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "../../web/endpoints";
import { AuthService } from "./auth.service";

const adminOf = (req: SessionRequest): Admin => ({ userId: req.human.user.id, email: req.human.user.email, workspaceId: req.human.workspace.id });

/** For anyone who is not an instance admin these pages do not exist: a 404, as the pages themselves always said. */
function onlyAdmins(req: SessionRequest) {
  if (!isInstanceAdmin(req.human.user.email)) throw new ServiceError("not_found", "Not found");
}

@Controller("api/app/admin")
@AppEndpoints()
@UseGuards(SessionGuard)
export class AdminController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Every workspace on this server: names, emails and counts only, never what a workspace wrote. */
  @Get("workspaces")
  async workspaces(@Req() req: SessionRequest) {
    onlyAdmins(req);
    return { workspaces: await this.auth.adminListWorkspaces(adminOf(req)) };
  }

  @Get("workspaces/:id")
  async workspace(@Req() req: SessionRequest, @Param("id") id: string) {
    onlyAdmins(req);
    return { workspace: await this.auth.getWorkspaceDetail(adminOf(req), id) };
  }

  /** `{ confirm, reason? }`: the workspace's exact name must be typed. Signs its members out; reversible. */
  @Post("workspaces/:id/suspend")
  @HttpCode(200)
  async suspend(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    onlyAdmins(req);
    const b = jsonBody(req);
    return this.auth.suspendWorkspace(adminOf(req), id, { confirmName: str(b.confirm), reason: str(b.reason) });
  }

  @Post("workspaces/:id/restore")
  @HttpCode(200)
  async restore(@Req() req: SessionRequest, @Param("id") id: string) {
    onlyAdmins(req);
    await this.auth.restoreWorkspace(adminOf(req), id);
    return { ok: true };
  }
}
