import { Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { AccountError, logIn, signUp, signupAllowed } from "@wheelhouse/core/lib/accounts";
import { endSession, humanFromSession, SESSION_COOKIE, startSession } from "@wheelhouse/core/lib/auth-core";
import { clientIp } from "@wheelhouse/core/lib/rate-limit";
import { cookieValue, toHeaders } from "../http/util";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody, str } from "./body";
import { AppEndpoints } from "./endpoints";
import { meView } from "./me";
import { clearSessionCookie, setSessionCookie } from "./session-cookie";

@Controller("api/app/auth")
@AppEndpoints()
export class AuthController {
  /** What a signed-out page needs to know. */
  @Get("options")
  async options() {
    return { signupOpen: await signupAllowed() };
  }

  /** Sign in. 200 with the signed-in person and their CSRF token; the session cookie is set. */
  @Post("login")
  @HttpCode(200)
  async login(@Req() req: RawTextRequest, @Res({ passthrough: true }) res: Response) {
    const b = jsonBody(req);
    const { userId } = await logIn({ email: str(b.email), password: str(b.password) }, clientIp(toHeaders(req.headers)));
    return this.begin(userId, res);
  }

  /** Create an account and a team they own. 201 with the signed-in person; the session cookie is set. */
  @Post("signup")
  @HttpCode(201)
  async signup(@Req() req: RawTextRequest, @Res({ passthrough: true }) res: Response) {
    const b = jsonBody(req);
    const { userId } = await signUp({ name: str(b.name), email: str(b.email), password: str(b.password), team: str(b.team) }, clientIp(toHeaders(req.headers)));
    return this.begin(userId, res);
  }

  /** Sign out: the session is deleted and the cookie cleared. Harmless when already signed out. */
  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await endSession(cookieValue(req.headers.cookie, SESSION_COOKIE));
    clearSessionCookie(res);
    return { ok: true };
  }

  private async begin(userId: string, res: Response) {
    const { token, expiresAt } = await startSession(userId);
    setSessionCookie(res, token, expiresAt);
    const human = await humanFromSession(token);
    if (!human) throw new AccountError("unauthorized", "Could not start a session");
    return meView(human, token);
  }
}
