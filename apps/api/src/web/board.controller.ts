import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { boardView, columnField, createIssueAs, issueInput } from "@wheelhouse/core/lib/board-app";
import { queueStatus } from "@wheelhouse/core/lib/service";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

@Controller("api/app/teams")
@AppEndpoints()
@UseGuards(SessionGuard)
export class BoardController {
  /** The team page in one read: columns, issues, the map nodes an issue can link to, the workspace's members and the setup checklist. */
  @Get(":key/board")
  board(@Req() req: SessionRequest, @Param("key") key: string) {
    return boardView(req.human.actor, key);
  }

  /** `{ title, column?, body?, priority?, assigneeId?, agentClaimable?, labels? }`. The column is an id, a name or a role; the first column by default. */
  @Post(":key/issues")
  @HttpCode(201)
  async create(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    const b = jsonBody(req);
    const input = issueInput(b, { create: true }) as { title: string };
    return { issue: await createIssueAs(req.human.actor, key, input, columnField(b, false)) };
  }

  /** The Bots menu: each agent key with its queue depth and live sessions in this team. */
  @Get(":key/queue")
  async queue(@Req() req: SessionRequest, @Param("key") key: string) {
    return { bots: await queueStatus(req.human.actor, key) };
  }
}
