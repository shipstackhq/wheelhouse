import { Controller, Inject, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { isInstanceAdmin } from "./auth-policy";
import { ServiceError } from "../../common/service-error";
import { type Admin, WorkspacesService } from "./workspaces.service";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { suspendWorkspaceDto, type SuspendWorkspaceDto } from "./dto/auth.dto";

const adminOf = (req: SessionRequest): Admin => ({ userId: req.human.user.id, email: req.human.user.email, workspaceId: req.human.workspace.id });

/** For anyone who is not an instance admin these pages do not exist: a 404, as the pages themselves always said. */
function onlyAdmins(req: SessionRequest) {
  if (!isInstanceAdmin(req.human.user.email)) throw new ServiceError("not_found", "Not found");
}

@Controller("api/app/admin")
@AppEndpoints()
export class AdminController {
  constructor(@Inject(WorkspacesService) private readonly admin: WorkspacesService) {}

  /** Every workspace on this server: names, emails and counts only, never what a workspace wrote. */
  @Get("workspaces")
  async workspaces(@Req() req: SessionRequest) {
    onlyAdmins(req);
    return { workspaces: await this.admin.adminListWorkspaces(adminOf(req)) };
  }

  @Get("workspaces/:id")
  async workspace(@Req() req: SessionRequest, @Param("id") id: string) {
    onlyAdmins(req);
    return { workspace: await this.admin.getWorkspaceDetail(adminOf(req), id) };
  }

  /** `{ confirm, reason? }`: the workspace's exact name must be typed. Signs its members out; reversible. */
  @Post("workspaces/:id/suspend")
  @HttpCode(200)
  async suspend(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody(new ZodValidationPipe(suspendWorkspaceDto)) body: SuspendWorkspaceDto) {
    onlyAdmins(req);
    return this.admin.suspendWorkspace(adminOf(req), id, { confirmName: body.confirm, reason: body.reason });
  }

  @Post("workspaces/:id/restore")
  @HttpCode(200)
  async restore(@Req() req: SessionRequest, @Param("id") id: string) {
    onlyAdmins(req);
    await this.admin.restoreWorkspace(adminOf(req), id);
    return { ok: true };
  }
}
