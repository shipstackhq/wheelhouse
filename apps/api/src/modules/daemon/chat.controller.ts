import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import type { JsonObject } from "../../common/body";
import { ChatService } from "./chat.service";

/** Chat with the codebase on the person's own device (docs/chat.md). A chat of someone else's is a 404. */
@Controller("api/app/chats")
@AppEndpoints()
export class ChatController {
  constructor(@Inject(ChatService) private readonly chats: ChatService) {}

  @Get()
  list(@Req() req: SessionRequest) {
    return this.chats.list(req.human.actor);
  }

  /** The person's devices and the team's repositories a chat can use. */
  @Get("options")
  options(@Req() req: SessionRequest, @Query("teamKey") teamKey: string) {
    return this.chats.options(req.human.actor, teamKey ?? "");
  }

  /** `{ teamKey, repositoryId, deviceId, model, message }`. */
  @Post()
  @HttpCode(201)
  create(@Req() req: SessionRequest, @JsonBody() body: JsonObject) {
    return this.chats.create(req.human.actor, body);
  }

  @Get(":id")
  get(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.chats.get(req.human.actor, id);
  }

  /** `{ message }`. */
  @Post(":id/messages")
  @HttpCode(201)
  send(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return this.chats.send(req.human.actor, id, body);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.chats.cancel(req.human.actor, id);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Req() req: SessionRequest, @Param("id") id: string) {
    await this.chats.remove(req.human.actor, id);
  }
}
