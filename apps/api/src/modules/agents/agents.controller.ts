import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AgentsService } from "./agents.service";
import { createAgentDto, pinDto, rosterDto, updateAgentDto, type CreateAgentDto, type PinDto, type RosterDto, type UpdateAgentDto } from "./dto/agents.dto";

/**
 * The Agents page and the team rosters (docs/agents-plan.md). Any member reads; who may change what is the service's rule. While the
 * workspace has agents switched off, the list says so and every other route is a 404 (a roster reads empty).
 */
@Controller("api/app")
@AppEndpoints()
export class AgentsController {
  constructor(@Inject(AgentsService) private readonly agents: AgentsService) {}

  /** `{ enabled, catalog, workspace }`: the catalog (with `latestVersion`, `pinnedVersion` and the version in use) and the workspace's own agents (each with `can`). */
  @Get("agents")
  list(@Req() req: SessionRequest) {
    return this.agents.list(req.human.actor);
  }

  /** `{ version, text }`: the Wheelhouse guardrails every agent is rendered with. Read only. */
  @Get("agents/guardrails")
  guardrails(@Req() req: SessionRequest) {
    return this.agents.guardrails(req.human.actor);
  }

  /** `{ versions }`, newest first, each with a short changelog. */
  @Get("agents/catalog/:slug/versions")
  async versions(@Req() req: SessionRequest, @Param("slug") slug: string) {
    return { versions: await this.agents.versions(req.human.actor, slug) };
  }

  /** `{ version | null }`: pin a catalog agent's version for the workspace, or follow the latest. Workspace admins only. */
  @Put("agents/catalog/:slug/pin")
  async pin(@Req() req: SessionRequest, @Param("slug") slug: string, @JsonBody(new ZodValidationPipe(pinDto)) body: PinDto) {
    return { agent: await this.agents.pin(req.human.actor, slug, body.version) };
  }

  /** `{ profile, teamKey? }`: a custom agent. 201 with the agent; a taken slug is a 409, a bad profile a 400 with its fields. */
  @Post("agents")
  @HttpCode(201)
  async create(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(createAgentDto)) body: CreateAgentDto) {
    return { agent: await this.agents.create(req.human.actor, body) };
  }

  /** `{ profile }` or `{ avatar }`: edit a custom agent, or only its face. */
  @Patch("agents/:slug")
  async update(@Req() req: SessionRequest, @Param("slug") slug: string, @JsonBody(new ZodValidationPipe(updateAgentDto)) body: UpdateAgentDto) {
    return { agent: await this.agents.update(req.human.actor, slug, body) };
  }

  /** Deletes a custom agent and takes it off every roster. */
  @Delete("agents/:slug")
  remove(@Req() req: SessionRequest, @Param("slug") slug: string) {
    return this.agents.remove(req.human.actor, slug);
  }

  /** `{ agents }`: the team's roster. Team members only; empty while agents are off. */
  @Get("teams/:key/agents")
  roster(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.agents.roster(req.human.actor, key);
  }

  /** `{ slug }`: put an agent on the team's roster. 201 with the agent; already there is a 409, another team's agent a 400. */
  @Post("teams/:key/agents")
  @HttpCode(201)
  async add(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody(new ZodValidationPipe(rosterDto)) body: RosterDto) {
    return { agent: await this.agents.addToRoster(req.human.actor, key, body.slug) };
  }

  @Delete("teams/:key/agents/:slug")
  removeFromTeam(@Req() req: SessionRequest, @Param("key") key: string, @Param("slug") slug: string) {
    return this.agents.removeFromRoster(req.human.actor, key, slug);
  }
}
