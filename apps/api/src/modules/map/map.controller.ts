import { Controller, Inject, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { ServiceError } from "../../common/service-error";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { requestOrigin } from "../../common/http/origin";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { resolveDraftDto, type ResolveDraftDto } from "./dto/map.dto";
import { BriefingService } from "./briefing.service";
import { DecisionsService } from "./decisions.service";
import { FreshnessService } from "./freshness.service";
import { GraphService } from "./graph.service";
import { askEnabled } from "./map.rules";
import { activityView, decisionView, edgeView, flowView, graphView, nodeView, termView, withCurrent } from "./map.presenter";
import type { NodeRow } from "./map.repository";

/** The map, decisions, glossary, activity and onboarding pages. A team, node, edge, flow, decision or term of another workspace is a 404. */
@Controller("api/app/teams")
@AppEndpoints()
export class MapController {
  constructor(
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(DecisionsService) private readonly decisions: DecisionsService,
    @Inject(FreshnessService) private readonly freshness: FreshnessService,
    @Inject(BriefingService) private readonly briefing: BriefingService,
  ) {}

  /** The whole map in one read: nodes, edges, issue links, flows, decisions, terms, what is in flux, and whether Ask is on. */
  @Get(":key/graph")
  async graphPage(@Req() req: SessionRequest, @Param("key") key: string) {
    return graphView(await this.graph.getGraph(req.human.actor, key), askEnabled());
  }

  /** Create (no `id`) or change (`id`) a node. `version` is the lock: a change made since is a 409 `conflict` with the node as it is now. */
  @Put(":key/nodes")
  async upsertNode(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { node: nodeView(await withCurrent(() => this.graph.upsertNodeAs(req.human.actor, key, body), nodeView as (raw: never) => unknown)) };
  }

  /** Deletes the node and everything nested inside it. */
  @Delete(":key/nodes/:id")
  @HttpCode(200)
  removeNode(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return this.graph.deleteNode(req.human.actor, key, id);
  }

  /** "Still accurate": clears the stale flag without changing what the node says. */
  @Post(":key/nodes/:id/fresh")
  @HttpCode(200)
  async fresh(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return { node: nodeView((await this.freshness.markFresh(req.human.actor, key, id)) as NodeRow) };
  }

  /** `{ positions: [{ id, x, y, width?, height? }], placed? }`: where nodes were put by a drag, a resize or a Tidy. */
  @Put(":key/layout")
  saveLayout(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return this.graph.saveLayoutAs(req.human.actor, key, body);
  }

  /** `{ from, to, label?, kind? }`: `depends` (the default) within a layer, `implements` from a lower layer to a higher one. */
  @Post(":key/edges")
  @HttpCode(200)
  async connect(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { edge: edgeView(await this.graph.connectAs(req.human.actor, key, body)) };
  }

  @Delete(":key/edges/:id")
  @HttpCode(200)
  removeEdge(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return this.graph.deleteEdge(req.human.actor, key, id);
  }

  /** `{ id?, name, description?, steps?: [{ node, title, detail? }], version? }`: steps are replaced wholesale. */
  @Put(":key/flows")
  async upsertFlow(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { flow: flowView(await withCurrent(() => this.graph.upsertFlowAs(req.human.actor, key, body), flowView as (raw: never) => unknown)) };
  }

  @Delete(":key/flows/:id")
  @HttpCode(200)
  removeFlow(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return this.graph.deleteFlow(req.human.actor, key, id);
  }

  /** Without `number` a new ADR is recorded; with it, that ADR is changed (and `version` is its lock). */
  @Put(":key/decisions")
  async upsertDecision(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { decision: decisionView(await withCurrent(() => this.decisions.upsertDecisionAs(req.human.actor, key, body), decisionView as (raw: never) => unknown)) };
  }

  /** `{ definition, node? }` defines (or redefines) the term named in the path. */
  @Put(":key/terms/:term")
  async upsertTerm(@Req() req: SessionRequest, @Param("key") key: string, @Param("term") term: string, @JsonBody() body: JsonObject) {
    return { term: termView(await this.decisions.upsertTermAs(req.human.actor, key, term, body)) };
  }

  @Delete(":key/terms/:term")
  @HttpCode(200)
  removeTerm(@Req() req: SessionRequest, @Param("key") key: string, @Param("term") term: string) {
    return this.decisions.deleteTerm(req.human.actor, key, term);
  }

  /** `{ action: "publish" | "discard" }` for a map update an agent drafted while its code was still in flux. */
  @Post(":key/drafts/:id/resolve")
  @HttpCode(200)
  async resolve(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string, @JsonBody(new ZodValidationPipe(resolveDraftDto)) body: ResolveDraftDto) {
    const action = body.action;
    if (action !== "publish" && action !== "discard") throw new ServiceError("invalid", "action must be publish or discard", { fields: { action: "publish or discard" } });
    return this.freshness.resolveDraft(req.human.actor, key, id, action);
  }

  /**
   * `{ question, focus? }`. Claude is called from the server with the server's own key, which is in no response. 20 questions per
   * person per 10 minutes. Another workspace's team is a 404 before anything is counted or called.
   */
  @Post(":key/ask")
  @HttpCode(200)
  ask(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return this.briefing.askAs(req.human.actor, key, body);
  }

  /** The team's last 200 events, newest first; `?who=agent` or `?who=human` narrows it. */
  @Get(":key/activity")
  async activity(@Req() req: SessionRequest, @Param("key") key: string, @Query("who") who?: string) {
    return { events: activityView(await this.briefing.activity(req.human.actor, key, who)) };
  }

  /** The wizard's data: the team, whether it has a repository, and the commands to paste with this team's key in them. */
  @Get(":key/onboarding")
  onboarding(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.briefing.onboardingPage(req.human.actor, key, requestOrigin(req));
  }

  /** `{ description }`: the "no code yet" path, a few sentences that become the map's first concept. */
  @Post(":key/onboarding/concept")
  @HttpCode(200)
  concept(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return this.briefing.createConceptAs(req.human.actor, key, body);
  }
}
