import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { markAllSeen } from "@wheelhouse/core/lib/service";
import { agentsPage, createKeyAs, revokeKeyAs, setKeyDocsWriteAs } from "@wheelhouse/core/lib/workspace-app";
import { ServiceError } from "@wheelhouse/core/lib/service";
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

  /** Reset an agent's queue (`keyId`), in one project (`projectKey`) or everywhere. */
  @Post("agents/mark-all-seen")
  @HttpCode(200)
  async markAllSeen(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    await markAllSeen(req.human.actor, { keyId: str(b.keyId) || undefined, projectRef: str(b.projectKey) || undefined });
    return { ok: true };
  }

  /** Create a key. The secret is in this response and nowhere else, ever. */
  @Post("keys")
  @HttpCode(201)
  create(@Req() req: SessionRequest & RawTextRequest) {
    return createKeyAs(req.human, str(jsonBody(req).name));
  }

  @Delete("keys/:id")
  @HttpCode(200)
  revoke(@Req() req: SessionRequest, @Param("id") id: string) {
    return revokeKeyAs(req.human, id);
  }

  /** `{ docsWrite: boolean }`: let this key create, edit and delete docs (off by default). */
  @Patch("keys/:id")
  async patch(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    const b = jsonBody(req);
    if (typeof b.docsWrite !== "boolean") throw new ServiceError("invalid", "docsWrite must be true or false", { fields: { docsWrite: "true or false" } });
    return { key: await setKeyDocsWriteAs(req.human, id, b.docsWrite) };
  }
}
