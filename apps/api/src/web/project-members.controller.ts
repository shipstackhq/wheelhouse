import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  addProjectMember,
  joinProjectAsWorkspaceAdmin,
  listAddableMembers,
  listAudit,
  listProjectMembers,
  listWorkspaceProjects,
  removeProjectMember,
  setProjectMemberRole,
} from "@wheelhouse/core/lib/project-members";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/**
 * Who is in a project, and the workspace-level views of access (ADR-23). Every rule (who may, the last admin, the audit line)
 * lives in core; this only reads the request and hands the signed-in person over.
 */
@Controller("api/app")
@AppEndpoints()
@UseGuards(SessionGuard)
export class ProjectMembersController {
  /** The project's members and the caller's own role in it. Any member may read it. */
  @Get("projects/:key/members")
  list(@Req() req: SessionRequest, @Param("key") key: string) {
    return listProjectMembers(req.human.actor, key);
  }

  /** Workspace members not yet in the project (project admins). */
  @Get("projects/:key/members/addable")
  async addable(@Req() req: SessionRequest, @Param("key") key: string) {
    return { people: await listAddableMembers(req.human.actor, key) };
  }

  /** `{ userId, role }` with role admin, editor or viewer. 201; someone already in is a 409. */
  @Post("projects/:key/members")
  @HttpCode(201)
  async add(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    const b = jsonBody(req);
    return { member: await addProjectMember(req.human.actor, key, { userId: str(b.userId), role: b.role }) };
  }

  /** `{ role }`. The last admin cannot be demoted (409). */
  @Patch("projects/:key/members/:userId")
  async setRole(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string, @Param("userId") userId: string) {
    return { member: await setProjectMemberRole(req.human.actor, key, userId, jsonBody(req).role) };
  }

  /** Remove someone, or leave yourself. The last admin cannot go (409). */
  @Delete("projects/:key/members/:userId")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("key") key: string, @Param("userId") userId: string) {
    return removeProjectMember(req.human.actor, key, userId);
  }

  /** A workspace owner or admin joins the project as its admin. Audited, and shown in the project's activity. */
  @Post("projects/:key/join")
  @HttpCode(200)
  join(@Req() req: SessionRequest, @Param("key") key: string) {
    return joinProjectAsWorkspaceAdmin(req.human.actor, key);
  }

  /** Every project of the workspace by name, with its admins and whether you are in it (owners and admins). */
  @Get("access/projects")
  async workspaceProjects(@Req() req: SessionRequest) {
    return { projects: await listWorkspaceProjects(req.human.actor) };
  }

  /** The access audit log, newest first (owners and admins). `?project=KEY` narrows it; `?limit=` up to 500. */
  @Get("access/audit")
  async audit(@Req() req: SessionRequest, @Query("project") project?: string, @Query("limit") limit?: string) {
    return { events: await listAudit(req.human.actor, { projectRef: project || undefined, limit: limit ? Number(limit) : undefined }) };
  }
}
