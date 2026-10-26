import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { str } from "../../../common/body";
import { AppEndpoints } from "../../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../../common/guards/session.guard";
import { WorkspacesService } from "./workspaces.service";
import { JsonBody } from "../../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { createWorkspaceDto, updateMemberDto, updateSettingsDto, transferOwnershipDto, type CreateWorkspaceDto, type TransferOwnershipDto, type UpdateMemberDto, type UpdateSettingsDto } from "../dto/auth.dto";

@Controller("api/app/workspace")
@AppEndpoints()
export class WorkspaceController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  /** The workspace page: members with roles and tags, the seats, and (for owners) the pending invites. */
  @Get()
  overview(@Req() req: SessionRequest) {
    return this.workspaces.workspaceOverview(req.human);
  }

  /** `{ agentsEnabled? }`: workspace settings. Owners and admins only (403 otherwise). Answers the settings. */
  @Patch("settings")
  async settings(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(updateSettingsDto)) body: UpdateSettingsDto) {
    return { settings: await this.workspaces.updateSettingsAs(req.human, body) };
  }

  /** Owners change a member's role and tags: `{ role, tags }` (tags as a list or a comma-separated string). */
  @Patch("members/:userId")
  async update(@Req() req: SessionRequest, @Param("userId") userId: string, @JsonBody(new ZodValidationPipe(updateMemberDto)) body: UpdateMemberDto) {
    return { member: await this.workspaces.updateMemberAs(req.human, { userId: str(userId), role: body.role, tags: body.tags }) };
  }

  /** `{ userId }`: the owner offers ownership to another member; it moves when they accept. */
  @Post("transfer")
  @HttpCode(200)
  requestTransfer(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(transferOwnershipDto)) body: TransferOwnershipDto) {
    return this.workspaces.requestTransfer(req.human, body.userId);
  }

  /** The owner withdraws the offer. */
  @Delete("transfer")
  @HttpCode(200)
  cancelTransfer(@Req() req: SessionRequest) {
    return this.workspaces.cancelTransfer(req.human);
  }

  /** The person offered ownership accepts: they become the owner and the current owners become admins. */
  @Post("transfer/accept")
  @HttpCode(200)
  acceptTransfer(@Req() req: SessionRequest) {
    return this.workspaces.acceptTransfer(req.human);
  }

  /** The person offered ownership declines. */
  @Post("transfer/decline")
  @HttpCode(200)
  declineTransfer(@Req() req: SessionRequest) {
    return this.workspaces.declineTransfer(req.human);
  }

  /** Owners remove a member of their own workspace (never themselves). */
  @Delete("members/:userId")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("userId") userId: string) {
    return this.workspaces.removeMemberAs(req.human, userId);
  }
}

@Controller("api/app/workspaces")
@AppEndpoints()
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  /** `{ name, slug? }`: any signed-in person creates a team workspace and owns it. Answers it, with its slug. */
  @Post()
  async create(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(createWorkspaceDto)) body: CreateWorkspaceDto) {
    return { workspace: await this.workspaces.createAs(req.human, body) };
  }
}
