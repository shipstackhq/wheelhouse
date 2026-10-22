import { Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { listWorkspaces, SESSION_COOKIE, switchWorkspace } from "@wheelhouse/core/lib/auth-core";
import { ServiceError } from "@wheelhouse/core/lib/service";
import { changePasswordAs } from "@wheelhouse/core/lib/workspace-app";
import type { RawTextRequest } from "../http/raw-text";
import { cookieValue } from "../http/util";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";
import { meView } from "./me";

@Controller("api/app/me")
@AppEndpoints()
export class MeController {
  /** The signed-in person, their workspace and role, and the CSRF token to send on state-changing requests. 401 when signed out. */
  @Get()
  @UseGuards(SessionGuard)
  me(@Req() req: SessionRequest) {
    return meView(req.human, cookieValue(req.headers.cookie, SESSION_COOKIE)!);
  }

  /** The workspaces this person belongs to (one that an instance admin suspended is left out), and which one this session is working in. */
  @Get("workspaces")
  @UseGuards(SessionGuard)
  async workspaces(@Req() req: SessionRequest) {
    return { workspaces: await listWorkspaces(req.human.user.id, req.human.workspace.id) };
  }

  /** `{ workspaceId }`: work in another of your workspaces. Only this session changes. Not one of yours, or suspended, is a 404. */
  @Post("workspace")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async switchTo(@Req() req: SessionRequest & RawTextRequest) {
    const workspace = await switchWorkspace(cookieValue(req.headers.cookie, SESSION_COOKIE)!, req.human.user.id, str(jsonBody(req).workspaceId));
    if (!workspace) throw new ServiceError("not_found", "Workspace not found");
    return { workspace };
  }

  /** Change your own password: `{ current, next }`. The current one must be right; the new one must be strong enough. */
  @Post("password")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  password(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return changePasswordAs(req.human, { current: str(b.current), next: str(b.next) });
  }
}
