import { Controller, Inject, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { statusField, issueInput } from "./issues.rules";
import { boardView } from "./issues.presenter";
import { queueStatus } from "../../lib/service-queue";
import { IssuesService } from "./issues.service";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";

@Controller("api/app/teams")
@AppEndpoints()
export class BoardController {
  constructor(@Inject(IssuesService) private readonly issues: IssuesService) {}

  /** The team page in one read: statuses, issues, the map nodes an issue can link to, the workspace's members and the setup checklist. */
  @Get(":key/board")
  async board(@Req() req: SessionRequest, @Param("key") key: string) {
    return boardView(await this.issues.boardPage(req.human.actor, key));
  }

  /** `{ title, status?, body?, priority?, assigneeId?, agentClaimable?, labels? }`. The status is an id, a name or a role; the first status by default. */
  @Post(":key/issues")
  @HttpCode(201)
  async create(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() b: JsonObject) {
    const input = issueInput(b, { create: true }) as { title: string };
    return { issue: await this.issues.createIssueAs(req.human.actor, key, input, statusField(b, false)) };
  }

  /** The Bots menu: each agent key with its queue depth and live sessions in this team. */
  @Get(":key/queue")
  async queue(@Req() req: SessionRequest, @Param("key") key: string) {
    return { bots: await queueStatus(req.human.actor, key) };
  }
}
