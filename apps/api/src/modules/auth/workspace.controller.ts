import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Req } from "@nestjs/common";
import { str } from "../../common/body";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { WorkspacesService } from "./workspaces.service";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { updateMemberDto, type UpdateMemberDto } from "./dto/auth.dto";

@Controller("api/app/workspace")
@AppEndpoints()
export class WorkspaceController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  /** The workspace page: members with roles and tags, the seats, and (for owners) the pending invites. */
  @Get()
  overview(@Req() req: SessionRequest) {
    return this.workspaces.workspaceOverview(req.human);
  }

  /** Owners change a member's role and tags: `{ role, tags }` (tags as a list or a comma-separated string). */
  @Patch("members/:userId")
  async update(@Req() req: SessionRequest, @Param("userId") userId: string, @JsonBody(new ZodValidationPipe(updateMemberDto)) body: UpdateMemberDto) {
    return { member: await this.workspaces.updateMemberAs(req.human, { userId: str(userId), role: body.role, tags: body.tags }) };
  }

  /** Owners remove a member of their own workspace (never themselves). */
  @Delete("members/:userId")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("userId") userId: string) {
    return this.workspaces.removeMemberAs(req.human, userId);
  }
}
