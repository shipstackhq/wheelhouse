import { Catch, Controller, Get, HttpCode, Inject, Param, Post, Req, Res, UseFilters, UseGuards, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { v1Failure } from "../common/errors/api-errors";
import { ToolsService } from "../lib/tools";
import { ActorGuard, type AuthedRequest } from "../common/guards/actor.guard";
import type { RawTextRequest } from "../common/http/raw-text";

/** Every failure becomes `{ error: { code, message, details? } }`, with the status and codes lib/api-errors.ts defines. */
@Catch()
export class V1ExceptionFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const f = v1Failure(e);
    host.switchToHttp().getResponse<Response>().status(f.status).set(f.headers ?? {}).json(f.body);
  }
}

@Controller("api/v1")
@UseFilters(V1ExceptionFilter)
export class V1Controller {
  constructor(@Inject(ToolsService) private readonly tools: ToolsService) {}

  /** Every tool, hidden ones included, for clients that discover them. No credentials needed. */
  @Get()
  list(@Res() res: Response) {
    res.json({ usage: "POST /api/v1/<name> with JSON body; Authorization: Bearer <api key>", tools: this.tools.list({ includeHidden: true }) });
  }

  /** POST /api/v1/<tool> with a JSON body of the tool's arguments. */
  @Post(":tool")
  @HttpCode(200)
  @UseGuards(ActorGuard)
  async run(@Param("tool") tool: string, @Req() req: AuthedRequest & RawTextRequest, @Res() res: Response) {
    let args: unknown = {};
    try {
      args = JSON.parse(req.rawText ?? "");
    } catch {
      /* an unparseable body counts as no arguments */
    }
    res.json({ data: await this.tools.run(req.actor, tool, args) });
  }
}
