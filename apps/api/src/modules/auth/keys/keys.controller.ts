import { Controller, Inject, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { markAllSeen } from "../../../lib/service-queue";
import { ServiceError } from "../../../common/service-error";
import { AppEndpoints } from "../../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../../common/guards/session.guard";
import { requestOrigin } from "../../../common/http/origin";
import { KeysService } from "./keys.service";
import { JsonBody } from "../../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { createKeyDto, markAllSeenDto, patchKeyDto, type CreateKeyDto, type MarkAllSeenDto, type PatchKeyDto } from "../dto/auth.dto";

@Controller("api/app")
@AppEndpoints()
export class KeysController {
  constructor(@Inject(KeysService) private readonly keys: KeysService) {}

  /** The API keys page: the workspace's keys (never the key values) and the commands to connect an agent. */
  @Get("keys")
  page(@Req() req: SessionRequest) {
    return this.keys.keysPage(req.human, requestOrigin(req));
  }

  /** Reset an agent's queue (`keyId`), in one team (`teamKey`) or everywhere. */
  @Post("keys/mark-all-seen")
  @HttpCode(200)
  async markAllSeen(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(markAllSeenDto)) body: MarkAllSeenDto) {
    await markAllSeen(req.human.actor, { keyId: body.keyId, teamRef: body.teamKey });
    return { ok: true };
  }

  /** `{ name, teams? }`: create a key. `teams` are the keys of the teams it can open (teams you edit; default all of them). The secret is in this response and nowhere else, ever. */
  @Post("keys")
  @HttpCode(201)
  create(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(createKeyDto)) body: CreateKeyDto) {
    return this.keys.createKeyAs(req.human, body.name, body.teams);
  }

  @Delete("keys/:id")
  @HttpCode(200)
  revoke(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.keys.revokeKeyAs(req.human, id);
  }

  /** `{ scopes?: string[], teams?: string[] }`: set what this key may do (its scopes), and/or the teams it can open. */
  @Patch("keys/:id")
  async patch(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody(new ZodValidationPipe(patchKeyDto)) b: PatchKeyDto) {
    if (b.scopes === undefined && b.teams === undefined) throw new ServiceError("invalid", "Send scopes or teams", { fields: { scopes: "a list of scopes" } });
    let key;
    if (b.scopes !== undefined) key = await this.keys.setKeyScopesAs(req.human, id, b.scopes);
    if (b.teams !== undefined) key = await this.keys.setKeyTeamsAs(req.human, id, b.teams);
    return { key };
  }
}
