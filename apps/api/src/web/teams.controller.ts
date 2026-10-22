import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { listTeamsWithRole, setTeamOrder } from "@wheelhouse/core/lib/team-members";
import { createTeam, deleteTeam, removeSession, ServiceError, updateTeam } from "@wheelhouse/core/lib/service";
import { getTeamSettings, parentCandidates, restoreTeam, retireTeam, setTeamParent } from "@wheelhouse/core/lib/team-lifecycle";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

const view = (p: { id: string; key: string; name: string; description: string; createdAt: Date; icon?: string | null; iconColor?: string | null; role?: string; retiredAt?: Date | null; parentId?: string | null }) => ({ id: p.id, key: p.key, name: p.name, description: p.description, createdAt: p.createdAt, icon: p.icon ?? null, iconColor: p.iconColor ?? null, retired: !!p.retiredAt, parentId: p.parentId ?? null, ...(p.role ? { role: p.role } : {}) });

@Controller("api/app/teams")
@AppEndpoints()
export class TeamsController {
  /** The person's teams, in the order they keep them (oldest first until they reorder). The workspace is the signed-in person's own; it is never taken from the request. */
  @Get()
  @UseGuards(SessionGuard)
  async list(@Req() req: SessionRequest) {
    return { teams: (await listTeamsWithRole(req.human.actor)).map(view) };
  }

  /** `{ keys }`: the order this person keeps their teams in, first to last. Theirs alone; the list above comes back in it. */
  @Put("order")
  @UseGuards(SessionGuard)
  async order(@Req() req: SessionRequest & RawTextRequest) {
    return setTeamOrder(req.human.actor, jsonBody(req).keys);
  }

  /** `{ name, key?, description? }`. The key defaults from the name. 201 with the team; a taken key is a 409. */
  @Post()
  @UseGuards(SessionGuard)
  @HttpCode(201)
  async create(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return { team: view(await createTeam(req.human.actor, { name: str(b.name), key: str(b.key) || undefined, description: str(b.description), parent: str(b.parent) || null })) };
  }

  /** The teams you can open that could be the parent of a team being created. */
  @Get("parent-candidates")
  @UseGuards(SessionGuard)
  async newParentCandidates(@Req() req: SessionRequest) {
    return { teams: await parentCandidates(req.human.actor) };
  }

  /** The teams you can open that could be this team's parent: not itself, not its descendants. Team admins. */
  @Get(":key/parent-candidates")
  @UseGuards(SessionGuard)
  async parentOptions(@Req() req: SessionRequest, @Param("key") key: string) {
    return { teams: await parentCandidates(req.human.actor, key) };
  }

  /** Team settings read: parent, children, and `canLeave` / `canRetire` / `canDelete`, each `{ allowed, reason }`. */
  @Get(":key/settings")
  @UseGuards(SessionGuard)
  settings(@Req() req: SessionRequest, @Param("key") key: string) {
    return getTeamSettings(req.human.actor, key);
  }

  /** `{ parent }`: a team key, or null to make the team top-level. Admin of the team, who must be able to open the parent. Cycles are a 400. */
  @Put(":key/parent")
  @UseGuards(SessionGuard)
  async setParent(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { team: view(await setTeamParent(req.human.actor, key, str(jsonBody(req).parent) || null)) };
  }

  /** Retire the team (admins). The last active team, a project lead and a team with active children are a 409. */
  @Post(":key/retire")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async retire(@Req() req: SessionRequest, @Param("key") key: string) {
    return { team: view(await retireTeam(req.human.actor, key)) };
  }

  /** Restore a retired team (admins of it). */
  @Post(":key/restore")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async restore(@Req() req: SessionRequest, @Param("key") key: string) {
    return { team: view(await restoreTeam(req.human.actor, key)) };
  }

  /** `{ confirm }`: the team key, typed. Deletes the team and everything in it (admins). */
  @Delete(":key")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  remove(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    if (str(jsonBody(req).confirm).trim().toUpperCase() !== key.toUpperCase()) throw new ServiceError("invalid", "Type the team key to confirm the delete");
    return deleteTeam(req.human.actor, key);
  }

  /** `{ name?, description?, icon?, iconColor? }`: team settings. `icon` is `ri:<name>` or one emoji, `null` clears it. Team admins only (403 otherwise); the key does not change. */
  @Patch(":key")
  @UseGuards(SessionGuard)
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    const b = jsonBody(req);
    return { team: view(await updateTeam(req.human.actor, key, { name: typeof b.name === "string" ? b.name : undefined, description: typeof b.description === "string" ? b.description : undefined, icon: b.icon, iconColor: b.iconColor })) };
  }

  /** Teammates remove an agent session from a team (soft delete: if it reconnects it starts at the top of the queue). */
  @Delete(":key/sessions/:sessionId")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  removeSession(@Req() req: SessionRequest, @Param("key") key: string, @Param("sessionId") sessionId: string) {
    return removeSession(req.human.actor, key, sessionId);
  }
}
