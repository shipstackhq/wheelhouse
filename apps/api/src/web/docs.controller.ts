import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { createDocAs, docsIndex, getDocAs, markDocFreshAs, moveDocAs, updateDocAs } from "../lib/docs-app";
import { deleteDoc, linkDocNode, suggestDocAnchors } from "../lib/service";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/** The docs page. A team, doc or map node of another workspace is a 404. A doc is addressed by its id. */
@Controller("api/app/teams")
@AppEndpoints()
@UseGuards(SessionGuard)
export class DocsController {
  /** The tree, and what the page's side panels offer: map nodes to link, decisions to link, the workspace's members. */
  @Get(":key/docs")
  index(@Req() req: SessionRequest, @Param("key") key: string) {
    return docsIndex(req.human, key);
  }

  @Get(":key/docs/:ref")
  get(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return getDocAs(req.human.actor, key, ref);
  }

  /** `{ title, body?, parent?, template? }`: a template fills the body when none is given. */
  @Post(":key/docs")
  async create(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { doc: await createDocAs(req.human.actor, key, jsonBody(req)) };
  }

  /** `{ title?, body?, anchors?, version? }`: with `version`, a doc changed since is a 409 `conflict` and nothing is overwritten. */
  @Patch(":key/docs/:ref")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return { doc: await updateDocAs(req.human.actor, key, ref, jsonBody(req)) };
  }

  /** "Still accurate": clears the stale flag without changing the doc. */
  @Post(":key/docs/:ref/fresh")
  @HttpCode(200)
  async fresh(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return { doc: await markDocFreshAs(req.human.actor, key, ref) };
  }

  /** File paths the doc probably describes: path-like words in its text and the anchors of the map nodes it is linked to. */
  @Get(":key/docs/:ref/anchor-suggestions")
  async suggestions(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return { anchors: await suggestDocAnchors(req.human.actor, key, ref) };
  }

  /** `{ parent?, index?, version? }`: `parent: null` is the top level. */
  @Post(":key/docs/:ref/move")
  @HttpCode(200)
  async move(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return { doc: await moveDocAs(req.human.actor, key, ref, jsonBody(req)) };
  }

  /** Deletes the doc and everything nested under it. */
  @Delete(":key/docs/:ref")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string) {
    return deleteDoc(req.human.actor, key, ref);
  }

  @Put(":key/docs/:ref/nodes/:nodeId")
  link(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return linkDocNode(req.human.actor, key, ref, nodeId, false);
  }

  @Delete(":key/docs/:ref/nodes/:nodeId")
  @HttpCode(200)
  unlink(@Req() req: SessionRequest, @Param("key") key: string, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return linkDocNode(req.human.actor, key, ref, nodeId, true);
  }
}
