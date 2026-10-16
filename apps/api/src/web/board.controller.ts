import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { boardView, columnField, createTicketAs, ticketInput } from "@wheelhouse/core/lib/board-app";
import { queueStatus } from "@wheelhouse/core/lib/service";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

@Controller("api/app/projects")
@AppEndpoints()
@UseGuards(SessionGuard)
export class BoardController {
  /** The project page in one read: columns, tickets, the map nodes a ticket can link to, the team's members and the setup checklist. */
  @Get(":key/board")
  board(@Req() req: SessionRequest, @Param("key") key: string) {
    return boardView(req.human.actor, key);
  }

  /** `{ title, column?, body?, priority?, assigneeId?, agentClaimable?, labels? }`. The column is an id, a name or a role; the first column by default. */
  @Post(":key/tickets")
  @HttpCode(201)
  async create(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    const b = jsonBody(req);
    const input = ticketInput(b, { create: true }) as { title: string };
    return { ticket: await createTicketAs(req.human.actor, key, input, columnField(b, false)) };
  }

  /** The Bots menu: each agent key with its queue depth and live sessions in this project. */
  @Get(":key/queue")
  async queue(@Req() req: SessionRequest, @Param("key") key: string) {
    return { bots: await queueStatus(req.human.actor, key) };
  }
}
