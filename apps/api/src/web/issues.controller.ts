import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { statusField, intField, moveIssueAs, issueDetail, issueInput, updateIssueAs } from "@wheelhouse/core/lib/board-app";
import { addComment, deleteIssue, linkIssueNode, ServiceError } from "@wheelhouse/core/lib/service";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/** An issue is addressed by its ref (WH-12), which already names its team. An issue of another workspace is a 404. */
@Controller("api/app/issues")
@AppEndpoints()
@UseGuards(SessionGuard)
export class IssuesController {
  /** The issue with its discussion, linked map nodes, history and pull requests. */
  @Get(":ref")
  get(@Req() req: SessionRequest, @Param("ref") ref: string) {
    return issueDetail(req.human.actor, ref);
  }

  /** Change fields. `version` (what you last read) makes a change by anyone since a 409 `conflict` with the current issue in `details.current`. */
  @Patch(":ref")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    const b = jsonBody(req);
    return { issue: await updateIssueAs(req.human.actor, ref, issueInput(b, { create: false }), intField(b, "version")) };
  }

  /** `{ status, index?, version? }`: the status by id, name or role (ADR-15); `index` is the place in it (the end when absent). */
  @Post(":ref/move")
  @HttpCode(200)
  async move(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    const b = jsonBody(req);
    return { issue: await moveIssueAs(req.human.actor, ref, statusField(b, true)!, intField(b, "index"), intField(b, "version")) };
  }

  @Delete(":ref")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("ref") ref: string) {
    return deleteIssue(req.human.actor, ref);
  }

  /** `{ body }` in Markdown. Agents see it in their queue. */
  @Post(":ref/comments")
  @HttpCode(201)
  async comment(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    const body = jsonBody(req).body;
    if (typeof body !== "string") throw new ServiceError("invalid", "Comment body is required", { fields: { body: "Comment body is required" } });
    const c = await addComment(req.human.actor, ref, body);
    return { comment: { id: c.id, authorKind: c.authorKind, authorName: c.authorName, body: c.body, createdAt: c.createdAt } };
  }

  /** Link the issue to a map node of its own team (an id or a name). */
  @Put(":ref/nodes/:nodeId")
  @HttpCode(200)
  link(@Req() req: SessionRequest, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return linkIssueNode(req.human.actor, ref, nodeId, false);
  }

  @Delete(":ref/nodes/:nodeId")
  @HttpCode(200)
  unlink(@Req() req: SessionRequest, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return linkIssueNode(req.human.actor, ref, nodeId, true);
  }
}
