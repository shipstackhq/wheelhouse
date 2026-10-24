import { Controller, Inject, Delete, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { isInstanceAdmin } from "./auth-policy";
import { SESSION_COOKIE } from "./auth-core";
import { clientIp } from "../../common/rate-limit";
import { ServiceError } from "../../lib/service";
import type { RawTextRequest } from "../../http/raw-text";
import { cookieValue, toHeaders } from "../../http/util";
import { jsonBody, str } from "../../web/body";
import { beginSession } from "./begin";
import { AppEndpoints, SessionGuard, type SessionRequest } from "../../web/endpoints";
import { requestOrigin } from "../../web/origin";
import { AuthService } from "./auth.service";

@Controller("api/app/invites")
@AppEndpoints()
export class InvitesController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Pending invites: `?kind=join_workspace` (owners; the default) or `?kind=new_workspace` (instance admins; anyone else gets a 404). */
  @Get()
  @UseGuards(SessionGuard)
  async list(@Req() req: SessionRequest, @Query("kind") kind?: string) {
    if (kind === "new_workspace") {
      if (!isInstanceAdmin(req.human.user.email)) throw new ServiceError("not_found", "Not found");
      return { invites: await this.auth.pendingInvites(req.human, "new_workspace") };
    }
    return { invites: await this.auth.pendingInvites(req.human, "join_workspace") };
  }

  /** `{ kind, email, role?, tags?, workspace? }`. The link is returned once: the token is in its #fragment and is not stored. */
  @Post()
  @UseGuards(SessionGuard)
  @HttpCode(201)
  create(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return this.auth.createInviteAs(req.human, { kind: b.kind, email: str(b.email), role: b.role, tags: b.tags, workspace: str(b.workspace), teams: b.teams }, requestOrigin(req));
  }

  /** Signed in with an existing account: what an invite sent to your own address would add you to. Anything else is the usual invalid-link answer. */
  @Post("peek-existing")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  async peekExisting(@Req() req: SessionRequest & RawTextRequest) {
    return { invite: await this.auth.peekInviteAsMemberAs(req.human, str(jsonBody(req).token)) };
  }

  /** Signed in with an existing account: join the workspace an invite for your own address names, then this session works in it. */
  @Post("accept-existing")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  acceptExisting(@Req() req: SessionRequest & RawTextRequest) {
    return this.auth.acceptInviteAsMemberAs(req.human, str(jsonBody(req).token), cookieValue(req.headers.cookie, SESSION_COOKIE)!);
  }

  /** Public, rate limited per address. POST so the token never sits in a URL or a log. The same answer for every bad link. */
  @Post("peek")
  @HttpCode(200)
  async peek(@Req() req: RawTextRequest) {
    return { invite: await this.auth.peekInviteAs(str(jsonBody(req).token), clientIp(toHeaders(req.headers))) };
  }

  /** Public. Creates the account like sign-up does and signs the new person in. `{ token, name, password, confirm }`. */
  @Post("accept")
  @HttpCode(201)
  async accept(@Req() req: RawTextRequest, @Res({ passthrough: true }) res: Response) {
    const b = jsonBody(req);
    const { userId } = await this.auth.acceptInviteAs({ token: str(b.token), name: str(b.name), password: str(b.password), confirm: str(b.confirm) }, clientIp(toHeaders(req.headers)));
    return beginSession(userId, res);
  }

  @Delete(":id")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  revoke(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.auth.revokeInviteAs(req.human, id);
  }
}
