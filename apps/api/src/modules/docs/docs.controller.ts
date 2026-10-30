import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { DocsService } from "./docs.service";
import { docView as view, docsIndexView, drawingView, withCurrentDoc, withCurrentDrawing } from "./docs.presenter";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";

/** The docs page. A team, doc or map node of another workspace is a 404. A doc is addressed by its id. */
@Controller("api/app/teams")
@AppEndpoints()
export class DocsController {
  constructor(@Inject(DocsService) private readonly docs: DocsService) {}

  /** The tree, and what the page's side panels offer: map nodes to link, decisions to link, the workspace's members. */
  @Get(":key/docs")
  async index(@Req() req: SessionRequest, @Param("key") key: string) {
    return docsIndexView(await this.docs.docsIndex(req.human, key));
  }

  // ───────── drawings (WH-146): docs of kind "drawing", shown under their own menu, never in the Docs tree ─────────

  /** The grid: newest edit first, thumbnails but no scene bodies. */
  @Get(":key/drawings")
  async drawings(@Req() req: SessionRequest, @Param("key") key: string) {
    return { drawings: await this.docs.listDrawings(req.human.actor, key) };
  }

  @Get(":key/drawings/:ref")
  async getDrawing(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return { drawing: drawingView(await this.docs.getDrawing(req.human.actor, key, ref)) };
  }

  /** `{ title, body?, thumbnail? }`: no body is an empty scene. */
  @Post(":key/drawings")
  async createDrawing(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { drawing: drawingView(await this.docs.createDrawingAs(req.human.actor, key, body)) };
  }

  /** `{ title?, body?, thumbnail?, version? }`: with `version`, a drawing changed since is a 409 `conflict` and nothing is overwritten. */
  @Patch(":key/drawings/:ref")
  async updateDrawing(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string, @JsonBody() body: JsonObject) {
    return { drawing: drawingView(await withCurrentDrawing(() => this.docs.updateDrawingAs(req.human.actor, key, ref, body))) };
  }

  @Delete(":key/drawings/:ref")
  @HttpCode(200)
  removeDrawing(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return this.docs.deleteDoc(req.human.actor, key, ref, "drawing");
  }

  @Get(":key/docs/:ref")
  async get(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    const { doc, nodes, owner, contributors } = await this.docs.getDoc(req.human.actor, key, ref);
    return { doc: view(doc), nodes, owner, contributors };
  }

  /** `{ title, body?, parent?, template? }`: a template fills the body when none is given. */
  @Post(":key/docs")
  async create(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { doc: view(await this.docs.createDocAs(req.human.actor, key, body)) };
  }

  /** `{ title?, body?, anchors?, version? }`: with `version`, a doc changed since is a 409 `conflict` and nothing is overwritten. */
  @Patch(":key/docs/:ref")
  async update(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string, @JsonBody() body: JsonObject) {
    return { doc: view(await withCurrentDoc(() => this.docs.updateDocAs(req.human.actor, key, ref, body))) };
  }

  /** "Still accurate": clears the stale flag without changing the doc. */
  @Post(":key/docs/:ref/fresh")
  @HttpCode(200)
  async fresh(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return { doc: view(await this.docs.markDocFresh(req.human.actor, key, ref)) };
  }

  /** File paths the doc probably describes: path-like words in its text and the anchors of the map nodes it is linked to. */
  @Get(":key/docs/:ref/anchor-suggestions")
  async suggestions(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return { anchors: await this.docs.suggestDocAnchors(req.human.actor, key, ref) };
  }

  /** `{ parent?, index?, version? }`: `parent: null` is the top level. */
  @Post(":key/docs/:ref/move")
  @HttpCode(200)
  async move(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string, @JsonBody() body: JsonObject) {
    return { doc: view(await withCurrentDoc(() => this.docs.moveDocAs(req.human.actor, key, ref, body))) };
  }

  /** Deletes the doc and everything nested under it. */
  @Delete(":key/docs/:ref")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return this.docs.deleteDoc(req.human.actor, key, ref);
  }

  @Put(":key/docs/:ref/nodes/:nodeId")
  link(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return this.docs.linkDocNode(req.human.actor, key, ref, nodeId, false);
  }

  @Delete(":key/docs/:ref/nodes/:nodeId")
  @HttpCode(200)
  unlink(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return this.docs.linkDocNode(req.human.actor, key, ref, nodeId, true);
  }
}
