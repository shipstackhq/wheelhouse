import { Controller, Get, Inject, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { type ConnectReply } from "./connect";
import { STATE_COOKIE, STATE_COOKIE_PATH } from "./state";
import { HumanGuard, SignedOutFilter, type HumanRequest } from "../../common/guards/human.guard";
import { cookieValue } from "../../common/http/cookies";
import { GithubService } from "./github.service";

/** Send what the github module decided about connecting GitHub: the redirect or text, and the state cookie. */
function send(res: Response, r: ConnectReply) {
  if (r.setStateCookie) res.cookie(STATE_COOKIE, r.setStateCookie.value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: STATE_COOKIE_PATH, maxAge: r.setStateCookie.maxAgeSec * 1000 });
  if (r.clearStateCookie) res.clearCookie(STATE_COOKIE, { path: STATE_COOKIE_PATH });
  if (r.redirect) res.redirect(r.status, r.redirect);
  else res.status(r.status).type("text/plain").send(r.text);
}

const query = (req: HumanRequest) => new URL(req.originalUrl, "http://localhost").searchParams;

@Controller("api/github")
@UseFilters(SignedOutFilter)
@UseGuards(HumanGuard)
export class GithubController {
  constructor(@Inject(GithubService) private readonly github: GithubService) {}

  /** Start connecting GitHub for a team: owners only. Sends the person to GitHub to install the App, with a signed `state`. */
  @Get("install")
  async install(@Req() req: HumanRequest, @Res() res: Response) {
    send(res, await this.github.startConnect(req.human, query(req).get("team") ?? ""));
  }

  /** Where GitHub sends people after they install the App. The checks that make the installation id trustworthy are core's. */
  @Get("callback")
  async callback(@Req() req: HumanRequest, @Res() res: Response) {
    const q = query(req);
    const nonce = cookieValue(req.headers.cookie, STATE_COOKIE);
    send(res, await this.github.finishConnect(req.human, { state: q.get("state"), installationId: q.get("installation_id"), code: q.get("code") }, nonce));
  }
}
