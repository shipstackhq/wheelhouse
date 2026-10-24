import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Req, UseGuards } from "@nestjs/common";
import type { RawTextRequest } from "../../http/raw-text";
import { jsonBody, str } from "../../common/body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "../../web/endpoints";
import { AuthService } from "./auth.service";

@Controller("api/app/workspace")
@AppEndpoints()
@UseGuards(SessionGuard)
export class WorkspaceController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** The workspace page: members with roles and tags, the seats, and (for owners) the pending invites. */
  @Get()
  overview(@Req() req: SessionRequest) {
    return this.auth.workspaceOverview(req.human);
  }

  /** Owners change a member's role and tags: `{ role, tags }` (tags as a list or a comma-separated string). */
  @Patch("members/:userId")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("userId") userId: string) {
    const b = jsonBody(req);
    return { member: await this.auth.updateMemberAs(req.human, { userId: str(userId), role: b.role, tags: b.tags }) };
  }

  /** Owners remove a member of their own workspace (never themselves). */
  @Delete("members/:userId")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("userId") userId: string) {
    return this.auth.removeMemberAs(req.human, userId);
  }
}
