import { Controller, Inject, Get, HttpCode, Post, Req } from "@nestjs/common";
import { SESSION_COOKIE } from "./auth-policy";
import { ServiceError } from "../../common/service-error";
import { cookieValue } from "../../common/http/cookies";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { meView } from "./auth.presenter";
import { SessionsService } from "./sessions.service";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { changePasswordDto, switchWorkspaceDto, type ChangePasswordDto, type SwitchWorkspaceDto } from "./dto/auth.dto";

@Controller("api/app/me")
@AppEndpoints()
export class MeController {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  /** The signed-in person, their workspace and role, and the CSRF token to send on state-changing requests. 401 when signed out. */
  @Get()
  me(@Req() req: SessionRequest) {
    return meView(req.human, cookieValue(req.headers.cookie, SESSION_COOKIE)!);
  }

  /** The workspaces this person belongs to (one that an instance admin suspended is left out), and which one this session is working in. */
  @Get("workspaces")
  async workspaces(@Req() req: SessionRequest) {
    return { workspaces: await this.sessions.listWorkspaces(req.human.user.id, req.human.workspace.id) };
  }

  /** `{ workspaceId }`: work in another of your workspaces. Only this session changes. Not one of yours, or suspended, is a 404. */
  @Post("workspace")
  @HttpCode(200)
  async switchTo(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(switchWorkspaceDto)) body: SwitchWorkspaceDto) {
    const workspace = await this.sessions.switchWorkspace(cookieValue(req.headers.cookie, SESSION_COOKIE)!, req.human.user.id, body.workspaceId);
    if (!workspace) throw new ServiceError("not_found", "Workspace not found");
    return { workspace };
  }

  /** Change your own password: `{ current, next }`. The current one must be right; the new one must be strong enough. */
  @Post("password")
  @HttpCode(200)
  password(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(changePasswordDto)) body: ChangePasswordDto) {
    return this.sessions.changePasswordAs(req.human, body);
  }
}
