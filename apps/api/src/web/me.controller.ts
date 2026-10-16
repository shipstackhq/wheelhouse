import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { SESSION_COOKIE } from "@wheelhouse/core/lib/auth-core";
import { cookieValue } from "../http/util";
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
}
