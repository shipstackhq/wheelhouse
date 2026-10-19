import { Controller, Delete, Get, HttpCode, Param, Patch, Req, UseGuards } from "@nestjs/common";
import { removeMemberAs, workspaceOverview, updateMemberAs } from "@wheelhouse/core/lib/workspace-app";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

@Controller("api/app/workspace")
@AppEndpoints()
@UseGuards(SessionGuard)
export class WorkspaceController {
  /** The workspace page: members with roles and tags, the seats, and (for owners) the pending invites. */
  @Get()
  overview(@Req() req: SessionRequest) {
    return workspaceOverview(req.human);
  }

  /** Owners change a member's role and tags: `{ role, tags }` (tags as a list or a comma-separated string). */
  @Patch("members/:userId")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("userId") userId: string) {
    const b = jsonBody(req);
    return { member: await updateMemberAs(req.human, { userId: str(userId), role: b.role, tags: b.tags }) };
  }

  /** Owners remove a member of their own workspace (never themselves). */
  @Delete("members/:userId")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("userId") userId: string) {
    return removeMemberAs(req.human, userId);
  }
}
