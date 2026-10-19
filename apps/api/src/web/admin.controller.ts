import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { isInstanceAdmin } from "@wheelhouse/core/lib/auth-policy";
import { ServiceError } from "@wheelhouse/core/lib/service";
import { getWorkspaceDetail, listWorkspaces, restoreWorkspace, suspendWorkspace, type Admin } from "@wheelhouse/core/lib/workspaces-admin";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

const adminOf = (req: SessionRequest): Admin => ({ userId: req.human.user.id, email: req.human.user.email, workspaceId: req.human.workspace.id });

/** For anyone who is not an instance admin these pages do not exist: a 404, as the pages themselves always said. */
function onlyAdmins(req: SessionRequest) {
  if (!isInstanceAdmin(req.human.user.email)) throw new ServiceError("not_found", "Not found");
}

@Controller("api/app/admin")
@AppEndpoints()
@UseGuards(SessionGuard)
export class AdminController {
  /** Every workspace on this server: names, emails and counts only, never what a workspace wrote. */
  @Get("workspaces")
  async workspaces(@Req() req: SessionRequest) {
    onlyAdmins(req);
    return { workspaces: await listWorkspaces(adminOf(req)) };
  }

  @Get("workspaces/:id")
  async workspace(@Req() req: SessionRequest, @Param("id") id: string) {
    onlyAdmins(req);
    return { workspace: await getWorkspaceDetail(adminOf(req), id) };
  }

  /** `{ confirm, reason? }`: the workspace's exact name must be typed. Signs its members out; reversible. */
  @Post("workspaces/:id/suspend")
  @HttpCode(200)
  async suspend(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    onlyAdmins(req);
    const b = jsonBody(req);
    return suspendWorkspace(adminOf(req), id, { confirmName: str(b.confirm), reason: str(b.reason) });
  }

  @Post("workspaces/:id/restore")
  @HttpCode(200)
  async restore(@Req() req: SessionRequest, @Param("id") id: string) {
    onlyAdmins(req);
    await restoreWorkspace(adminOf(req), id);
    return { ok: true };
  }
}
