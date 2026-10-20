import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  addProjectTeamAs,
  createMilestoneAs,
  createProjectAs,
  deleteMilestoneAs,
  deleteProjectAs,
  getProjectAs,
  listProjectsAs,
  removeProjectTeamAs,
  updateMilestoneAs,
  updateProjectAs,
} from "@wheelhouse/core/lib/projects-app";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/**
 * Projects (WH-118): outcomes that end and can span teams. They belong to the workspace, and a person sees one only through a team
 * of theirs that takes part (never as a guest); the teams they are not on are only counted. A project that is not visible to the
 * caller is a 404, the same as one that does not exist.
 */
@Controller("api/app/projects")
@AppEndpoints()
@UseGuards(SessionGuard)
export class ProjectsController {
  /** `{ projects }`: the visible ones, active first, each with its health, lead and how many issues are done. */
  @Get()
  async list(@Req() req: SessionRequest) {
    return { projects: await listProjectsAs(req.human.actor) };
  }

  /** `{ name, leadTeam, description?, status?, startDate?, targetDate?, leadUser?, healthOverride?, teams? }`; 201. The lead team is a team you can edit. */
  @Post()
  async create(@Req() req: SessionRequest & RawTextRequest) {
    return { project: await createProjectAs(req.human.actor, jsonBody(req)) };
  }

  /** One project: its milestones, the viewer's own teams with their issues, the totals of the other teams, and the teams they could bring in. */
  @Get(":id")
  async one(@Req() req: SessionRequest, @Param("id") id: string) {
    return { project: await getProjectAs(req.human.actor, id) };
  }

  /** Any of the create fields, `healthOverride: null` to clear it, and `version` for the lock. Changing the lead needs the lead or an admin of the lead team. */
  @Patch(":id")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    return { project: await updateProjectAs(req.human.actor, id, jsonBody(req)) };
  }

  /** Soft delete: its issues stay on their boards, in no project. */
  @Delete(":id")
  async remove(@Req() req: SessionRequest, @Param("id") id: string) {
    return deleteProjectAs(req.human.actor, id);
  }

  /** `{ team }`: bring in a team you can edit. */
  @Post(":id/teams")
  async addTeam(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    return { project: await addProjectTeamAs(req.human.actor, id, jsonBody(req)) };
  }

  /** Take a team out. A team with issues in the project is a 409 unless `?releaseIssues=1`; the lead team cannot go. */
  @Delete(":id/teams/:key")
  async removeTeam(@Req() req: SessionRequest, @Param("id") id: string, @Param("key") key: string, @Query("releaseIssues") release?: string) {
    return removeProjectTeamAs(req.human.actor, id, key, release === "1" || release === "true");
  }

  /** `{ name, description?, targetDate? }`; 201. */
  @Post(":id/milestones")
  async addMilestone(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    return { project: await createMilestoneAs(req.human.actor, id, jsonBody(req)) };
  }

  /** Any of `name`, `description`, `targetDate`, and `index` to move it in the order. */
  @Patch(":id/milestones/:milestoneId")
  async patchMilestone(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string, @Param("milestoneId") milestoneId: string) {
    return { project: await updateMilestoneAs(req.human.actor, id, milestoneId, jsonBody(req)) };
  }

  /** Its issues stay in the project, in no milestone. */
  @Delete(":id/milestones/:milestoneId")
  @HttpCode(200)
  async removeMilestone(@Req() req: SessionRequest, @Param("id") id: string, @Param("milestoneId") milestoneId: string) {
    return { project: await deleteMilestoneAs(req.human.actor, id, milestoneId) };
  }
}
