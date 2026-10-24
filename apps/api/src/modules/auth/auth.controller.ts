import { Controller, Inject, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { SESSION_COOKIE } from "./auth-core";
import { clientIp } from "../../common/rate-limit";
import { cookieValue, toHeaders } from "../../common/http/cookies";
import type { RawTextRequest } from "../../common/http/raw-text";
import { jsonBody, str } from "../../common/body";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { beginSession } from "./begin";
import { clearSessionCookie } from "../../common/http/session-cookie";
import { AuthService } from "./auth.service";
import { Public } from "../../common/decorators/public.decorator";

@Controller("api/app/auth")
@AppEndpoints()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** What a signed-out page needs to know. */
  @Public()
  @Get("options")
  async options() {
    return { signupOpen: await this.auth.signupAllowed() };
  }

  /** Sign in. 200 with the signed-in person and their CSRF token; the session cookie is set. */
  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Req() req: RawTextRequest, @Res({ passthrough: true }) res: Response) {
    const b = jsonBody(req);
    const { userId } = await this.auth.logIn({ email: str(b.email), password: str(b.password) }, clientIp(toHeaders(req.headers)));
    return this.begin(userId, res);
  }

  /** Create an account and a workspace they own. 201 with the signed-in person; the session cookie is set. */
  @Public()
  @Post("signup")
  @HttpCode(201)
  async signup(@Req() req: RawTextRequest, @Res({ passthrough: true }) res: Response) {
    const b = jsonBody(req);
    const { userId } = await this.auth.signUp({ name: str(b.name), email: str(b.email), password: str(b.password), workspace: str(b.workspace) }, clientIp(toHeaders(req.headers)));
    return this.begin(userId, res);
  }

  /** Sign out: the session is deleted and the cookie cleared. Harmless when already signed out. */
  @Public()
  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.endSession(cookieValue(req.headers.cookie, SESSION_COOKIE));
    clearSessionCookie(res);
    return { ok: true };
  }

  private begin(userId: string, res: Response) {
    return beginSession(userId, res);
  }
}
