import { Controller, Inject, Get, HttpCode, Post, Req } from "@nestjs/common";
import { SESSION_COOKIE } from "./auth-core";
import { ServiceError } from "../../common/service-error";
import type { RawTextRequest } from "../../common/http/raw-text";
import { cookieValue } from "../../common/http/cookies";
import { jsonBody, str } from "../../common/body";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { meView } from "./me";
import { AuthService } from "./auth.service";

@Controller("api/app/me")
@AppEndpoints()
export class MeController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** The signed-in person, their workspace and role, and the CSRF token to send on state-changing requests. 401 when signed out. */
  @Get()
  me(@Req() req: SessionRequest) {
    return meView(req.human, cookieValue(req.headers.cookie, SESSION_COOKIE)!);
  }

  /** The workspaces this person belongs to (one that an instance admin suspended is left out), and which one this session is working in. */
  @Get("workspaces")
  async workspaces(@Req() req: SessionRequest) {
    return { workspaces: await this.auth.listWorkspaces(req.human.user.id, req.human.workspace.id) };
  }

  /** `{ workspaceId }`: work in another of your workspaces. Only this session changes. Not one of yours, or suspended, is a 404. */
  @Post("workspace")
  @HttpCode(200)
  async switchTo(@Req() req: SessionRequest & RawTextRequest) {
    const workspace = await this.auth.switchWorkspace(cookieValue(req.headers.cookie, SESSION_COOKIE)!, req.human.user.id, str(jsonBody(req).workspaceId));
    if (!workspace) throw new ServiceError("not_found", "Workspace not found");
    return { workspace };
  }

  /** Change your own password: `{ current, next }`. The current one must be right; the new one must be strong enough. */
  @Post("password")
  @HttpCode(200)
  password(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return this.auth.changePasswordAs(req.human, { current: str(b.current), next: str(b.next) });
  }
}
