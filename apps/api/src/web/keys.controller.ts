import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { markAllSeen } from "../lib/service";
import { agentsPage, createKeyAs, revokeKeyAs, setKeyDocsWriteAs, setKeyTeamsAs } from "../lib/workspace-app";
import { ServiceError } from "../lib/service";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";
import { requestOrigin } from "./origin";

@Controller("api/app")
@AppEndpoints()
@UseGuards(SessionGuard)
export class KeysController {
  /** The Agents page: the workspace's keys (never the key values) and the commands to connect an agent. */
  @Get("agents")
  agents(@Req() req: SessionRequest) {
    return agentsPage(req.human, requestOrigin(req));
  }

  /** Reset an agent's queue (`keyId`), in one team (`teamKey`) or everywhere. */
  @Post("agents/mark-all-seen")
  @HttpCode(200)
  async markAllSeen(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    await markAllSeen(req.human.actor, { keyId: str(b.keyId) || undefined, teamRef: str(b.teamKey) || undefined });
    return { ok: true };
  }

  /** `{ name, teams? }`: create a key. `teams` are the keys of the teams it can open (teams you edit; default all of them). The secret is in this response and nowhere else, ever. */
  @Post("keys")
  @HttpCode(201)
  create(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return createKeyAs(req.human, str(b.name), b.teams);
  }

  @Delete("keys/:id")
  @HttpCode(200)
  revoke(@Req() req: SessionRequest, @Param("id") id: string) {
    return revokeKeyAs(req.human, id);
  }

  /** `{ docsWrite?: boolean, teams?: string[] }`: let this key edit docs (off by default), and/or set the teams it can open. */
  @Patch("keys/:id")
  async patch(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    const b = jsonBody(req);
    if (b.docsWrite === undefined && b.teams === undefined) throw new ServiceError("invalid", "Send docsWrite or teams", { fields: { docsWrite: "true or false" } });
    if (b.docsWrite !== undefined && typeof b.docsWrite !== "boolean") throw new ServiceError("invalid", "docsWrite must be true or false", { fields: { docsWrite: "true or false" } });
    let key;
    if (b.docsWrite !== undefined) key = await setKeyDocsWriteAs(req.human, id, b.docsWrite as boolean);
    if (b.teams !== undefined) key = await setKeyTeamsAs(req.human, id, b.teams);
    return { key };
  }
}
