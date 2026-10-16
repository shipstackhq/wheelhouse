import { Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { SESSION_COOKIE } from "@wheelhouse/core/lib/auth-core";
import { changePasswordAs } from "@wheelhouse/core/lib/team-app";
import type { RawTextRequest } from "../http/raw-text";
import { cookieValue } from "../http/util";
import { jsonBody, str } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";
import { meView } from "./me";

@Controller("api/app/me")
@AppEndpoints()
export class MeController {
  /** The signed-in person, their team and role, and the CSRF token to send on state-changing requests. 401 when signed out. */
  @Get()
  @UseGuards(SessionGuard)
  me(@Req() req: SessionRequest) {
    return meView(req.human, cookieValue(req.headers.cookie, SESSION_COOKIE)!);
  }

  /** Change your own password: `{ current, next }`. The current one must be right; the new one must be strong enough. */
  @Post("password")
  @UseGuards(SessionGuard)
  @HttpCode(200)
  password(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return changePasswordAs(req.human, { current: str(b.current), next: str(b.next) });
  }
}
