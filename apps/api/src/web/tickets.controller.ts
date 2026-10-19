import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { columnField, intField, moveTicketAs, ticketDetail, ticketInput, updateTicketAs } from "@wheelhouse/core/lib/board-app";
import { addComment, deleteTicket, linkTicketNode, ServiceError } from "@wheelhouse/core/lib/service";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/** A ticket is addressed by its ref (WH-12), which already names its project. A ticket of another workspace is a 404. */
@Controller("api/app/tickets")
@AppEndpoints()
@UseGuards(SessionGuard)
export class TicketsController {
  /** The ticket with its discussion, linked map nodes, history and pull requests. */
  @Get(":ref")
  get(@Req() req: SessionRequest, @Param("ref") ref: string) {
    return ticketDetail(req.human.actor, ref);
  }

  /** Change fields. `version` (what you last read) makes a change by anyone since a 409 `conflict` with the current ticket in `details.current`. */
  @Patch(":ref")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    const b = jsonBody(req);
    return { ticket: await updateTicketAs(req.human.actor, ref, ticketInput(b, { create: false }), intField(b, "version")) };
  }

  /** `{ column, index?, version? }`: the column by id, name or role (ADR-15); `index` is the place in it (the end when absent). */
  @Post(":ref/move")
  @HttpCode(200)
  async move(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    const b = jsonBody(req);
    return { ticket: await moveTicketAs(req.human.actor, ref, columnField(b, true)!, intField(b, "index"), intField(b, "version")) };
  }

  @Delete(":ref")
  @HttpCode(200)
  remove(@Req() req: SessionRequest, @Param("ref") ref: string) {
    return deleteTicket(req.human.actor, ref);
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

  /** Link the ticket to a map node of its own project (an id or a name). */
  @Put(":ref/nodes/:nodeId")
  @HttpCode(200)
  link(@Req() req: SessionRequest, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return linkTicketNode(req.human.actor, ref, nodeId, false);
  }

  @Delete(":ref/nodes/:nodeId")
  @HttpCode(200)
  unlink(@Req() req: SessionRequest, @Param("ref") ref: string, @Param("nodeId") nodeId: string) {
    return linkTicketNode(req.human.actor, ref, nodeId, true);
  }
}
