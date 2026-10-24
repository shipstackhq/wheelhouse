import { Controller, Inject, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { nodeView } from "./map-app";
import { ServiceError } from "../../common/service-error";
import { MapService } from "./map.service";
import type { RawTextRequest } from "../../common/http/raw-text";
import { jsonBody, str } from "../../common/body";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { SessionGuard, type SessionRequest } from "../../common/guards/session.guard";

/** The map, decisions, glossary and activity pages. A team, node, edge, flow, decision or term of another workspace is a 404. */
@Controller("api/app/teams")
@AppEndpoints()
@UseGuards(SessionGuard)
export class MapController {
  constructor(@Inject(MapService) private readonly map: MapService) {}

  /** The whole map in one read: nodes, edges, issue links, flows, decisions, terms, what is in flux, and whether Ask is on. */
  @Get(":key/graph")
  graph(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.map.graphView(req.human.actor, key);
  }

  /** Create (no `id`) or change (`id`) a node. `version` is the lock: a change made since is a 409 `conflict` with the node as it is now. */
  @Put(":key/nodes")
  async upsertNode(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { node: await this.map.upsertNodeAs(req.human.actor, key, jsonBody(req)) };
  }

  /** Deletes the node and everything nested inside it. */
  @Delete(":key/nodes/:id")
  @HttpCode(200)
  removeNode(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return this.map.deleteNode(req.human.actor, key, id);
  }

  /** "Still accurate": clears the stale flag without changing what the node says. */
  @Post(":key/nodes/:id/fresh")
  @HttpCode(200)
  async fresh(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return { node: nodeView(await this.map.markFresh(req.human.actor, key, id)) };
  }

  /** `{ positions: [{ id, x, y, width?, height? }], placed? }`: where nodes were put by a drag, a resize or a Tidy. */
  @Put(":key/layout")
  saveLayout(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return this.map.saveLayoutAs(req.human.actor, key, jsonBody(req));
  }

  /** `{ from, to, label?, kind? }`: `depends` (the default) within a layer, `implements` from a lower layer to a higher one. */
  @Post(":key/edges")
  @HttpCode(200)
  async connect(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { edge: await this.map.connectAs(req.human.actor, key, jsonBody(req)) };
  }

  @Delete(":key/edges/:id")
  @HttpCode(200)
  removeEdge(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return this.map.deleteEdge(req.human.actor, key, id);
  }

  /** `{ id?, name, description?, steps?: [{ node, title, detail? }], version? }`: steps are replaced wholesale. */
  @Put(":key/flows")
  async upsertFlow(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { flow: await this.map.upsertFlowAs(req.human.actor, key, jsonBody(req)) };
  }

  @Delete(":key/flows/:id")
  @HttpCode(200)
  removeFlow(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return this.map.deleteFlow(req.human.actor, key, id);
  }

  /** Without `number` a new ADR is recorded; with it, that ADR is changed (and `version` is its lock). */
  @Put(":key/decisions")
  async upsertDecision(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { decision: await this.map.upsertDecisionAs(req.human.actor, key, jsonBody(req)) };
  }

  /** `{ definition, node? }` defines (or redefines) the term named in the path. */
  @Put(":key/terms/:term")
  async upsertTerm(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string, @Param("term") term: string) {
    return { term: await this.map.upsertTermAs(req.human.actor, key, term, jsonBody(req)) };
  }

  @Delete(":key/terms/:term")
  @HttpCode(200)
  removeTerm(@Req() req: SessionRequest, @Param("key") key: string, @Param("term") term: string) {
    return this.map.deleteTerm(req.human.actor, key, term);
  }

  /** `{ action: "publish" | "discard" }` for a map update an agent drafted while its code was still in flux. */
  @Post(":key/drafts/:id/resolve")
  @HttpCode(200)
  async resolve(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string, @Param("id") id: string) {
    const action = str(jsonBody(req).action);
    if (action !== "publish" && action !== "discard") throw new ServiceError("invalid", "action must be publish or discard", { fields: { action: "publish or discard" } });
    return this.map.resolveDraft(req.human.actor, key, id, action);
  }

  /**
   * `{ question, focus? }`. Claude is called from the server with the server's own key, which is in no response. 20 questions per
   * person per 10 minutes. Another workspace's team is a 404 before anything is counted or called.
   */
  @Post(":key/ask")
  @HttpCode(200)
  ask(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return this.map.askAs(req.human.actor, key, jsonBody(req));
  }

  /** The team's last 200 events, newest first; `?who=agent` or `?who=human` narrows it. */
  @Get(":key/activity")
  async activity(@Req() req: SessionRequest, @Param("key") key: string, @Query("who") who?: string) {
    return { events: await this.map.activityView(req.human.actor, key, who) };
  }
}
