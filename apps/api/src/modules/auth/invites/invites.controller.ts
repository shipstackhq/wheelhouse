import { Controller, Inject, Delete, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { isInstanceAdmin, SESSION_COOKIE } from "../auth-policy";
import { clientIp } from "../../../common/rate-limit";
import { ServiceError } from "../../../common/service-error";
import { cookieValue, toHeaders } from "../../../common/http/cookies";
import { meView } from "../auth.presenter";
import { AppEndpoints } from "../../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../../common/guards/session.guard";
import { requestOrigin } from "../../../common/http/origin";
import { setSessionCookie } from "../../../common/http/session-cookie";
import { InvitesService } from "./invites.service";
import { SessionsService } from "../sessions.service";
import { Public } from "../../../common/decorators/public.decorator";
import { JsonBody } from "../../../common/decorators/json-body.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { acceptInviteDto, createInviteDto, inviteTokenDto, type AcceptInviteDto, type CreateInviteDto, type InviteTokenDto } from "../dto/auth.dto";

@Controller("api/app/invites")
@AppEndpoints()
export class InvitesController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService, @Inject(SessionsService) private readonly sessions: SessionsService) {}

  /** Pending invites: `?kind=join_workspace` (owners; the default) or `?kind=new_workspace` (instance admins; anyone else gets a 404). */
  @Get()
  async list(@Req() req: SessionRequest, @Query("kind") kind?: string) {
    if (kind === "new_workspace") {
      if (!isInstanceAdmin(req.human.user.email)) throw new ServiceError("not_found", "Not found");
      return { invites: await this.invites.pendingInvites(req.human, "new_workspace") };
    }
    return { invites: await this.invites.pendingInvites(req.human, "join_workspace") };
  }

  /** `{ kind, email, role?, tags?, workspace? }`. The link is returned once: the token is in its #fragment and is not stored. */
  @Post()
  @HttpCode(201)
  create(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(createInviteDto)) body: CreateInviteDto) {
    return this.invites.createInviteAs(req.human, body, requestOrigin(req));
  }

  /** Signed in with an existing account: what an invite sent to your own address would add you to. Anything else is the usual invalid-link answer. */
  @Post("peek-existing")
  @HttpCode(200)
  async peekExisting(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(inviteTokenDto)) body: InviteTokenDto) {
    return { invite: await this.invites.peekInviteAsMemberAs(req.human, body.token) };
  }

  /** Signed in with an existing account: join the workspace an invite for your own address names, then this session works in it. */
  @Post("accept-existing")
  @HttpCode(200)
  acceptExisting(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(inviteTokenDto)) body: InviteTokenDto) {
    return this.invites.acceptInviteAsMemberAs(req.human, body.token, cookieValue(req.headers.cookie, SESSION_COOKIE)!);
  }

  /** Public, rate limited per address. POST so the token never sits in a URL or a log. The same answer for every bad link. */
  @Public()
  @Post("peek")
  @HttpCode(200)
  async peek(@Req() req: Request, @JsonBody(new ZodValidationPipe(inviteTokenDto)) body: InviteTokenDto) {
    return { invite: await this.invites.peekInviteAs(body.token, clientIp(toHeaders(req.headers))) };
  }

  /** Public. Creates the account like sign-up does and signs the new person in. `{ token, name, password, confirm }`. */
  @Public()
  @Post("accept")
  @HttpCode(201)
  async accept(@Req() req: Request, @Res({ passthrough: true }) res: Response, @JsonBody(new ZodValidationPipe(acceptInviteDto)) body: AcceptInviteDto) {
    const { userId } = await this.invites.acceptInviteAs(body, clientIp(toHeaders(req.headers)));
    const { human, token } = await this.sessions.begin(userId, (t, expiresAt) => setSessionCookie(res, t, expiresAt));
    return meView(human, token);
  }

  @Delete(":id")
  @HttpCode(200)
  revoke(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.invites.revokeInviteAs(req.human, id);
  }
}
