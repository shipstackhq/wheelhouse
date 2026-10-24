import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { statusField, intField, issueInput } from "./board-app";
import { ServiceError } from "../../common/service-error";
import { IssuesService } from "./issues.service";
import type { RawTextRequest } from "../../common/http/raw-text";
import { jsonBody } from "../../common/body";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";

/** An issue is addressed by its ref (WH-12), which already names its team. An issue of another workspace is a 404. */
@Controller("api/app/issues")
@AppEndpoints()
export class IssuesController {
  constructor(@Inject(IssuesService) private readonly issues: IssuesService) {}

  /** The issue with its discussion, linked map nodes, history and pull requests. */
  @Get(":ref")
  get(@Req() req: SessionRequest, @Param("ref") ref: string) {
    return this.issues.issueDetail(req.human.actor, ref);
  }

  /** Change fields. `version` (what you last read) makes a change by anyone since a 409 `conflict` with the current issue in `details.current`. */
  @Patch(":ref")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    const b = jsonBody(req);
    return { issue: await this.issues.updateIssueAs(req.human.actor, ref, issueInput(b, { create: false }), intField(b, "version")) };
  }

  /** `{ status, index?, version? }`: the status by id, name or role (ADR-15); `index` is the place in it (the end when absent). */
  @Post(":ref/move")
  @HttpCode(200)
  async move(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    const b = jsonBody(req);
    return { issue: await this.issues.moveIssueAs(req.human.actor, ref, statusField(b, true)!, intField(b, "index"), intField(b, "version")) };
  }

  @Delete(":ref")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("ref") ref: string) {
    return this.issues.deleteIssue(req.human.actor, ref);
  }

  /** `{ body }` in Markdown. Agents see it in their queue. */
  @Post(":ref/comments")
  @HttpCode(201)
  async comment(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    const body = jsonBody(req).body;
    if (typeof body !== "string") throw new ServiceError("invalid", "Comment body is required", { fields: { body: "Comment body is required" } });
    const c = await this.issues.addComment(req.human.actor, ref, body);
    return { comment: { id: c.id, authorKind: c.authorKind, authorName: c.authorName, body: c.body, createdAt: c.createdAt } };
  }

  /** Link the issue to a map node of its own team (an id or a name). */
  @Put(":ref/nodes/:nodeId")
  @HttpCode(200)
  link(@Req() req: SessionRequest, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return this.issues.linkIssueNode(req.human.actor, ref, nodeId, false);
  }

  @Delete(":ref/nodes/:nodeId")
  @HttpCode(200)
  unlink(@Req() req: SessionRequest, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return this.issues.linkIssueNode(req.human.actor, ref, nodeId, true);
  }
}
