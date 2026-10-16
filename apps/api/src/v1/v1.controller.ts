import { Catch, Controller, Get, HttpCode, Param, Post, Req, Res, UseFilters, UseGuards, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { v1Failure } from "@wheelhouse/core/lib/api-errors";
import { listToolDefs, runTool } from "@wheelhouse/core/lib/tools";
import { ActorGuard, type AuthedRequest } from "../auth/actor.guard";
import type { RawTextRequest } from "../http/raw-text";

/** Every failure becomes `{ error: { code, message, details? } }`, with the status and codes @wheelhouse/core defines. */
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
  /** Every tool, hidden ones included, for clients that discover them. No credentials needed. */
  @Get()
  list(@Res() res: Response) {
    res.json({ usage: "POST /api/v1/<name> with JSON body; Authorization: Bearer <api key>", tools: listToolDefs({ includeHidden: true }) });
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
    res.json({ data: await runTool(req.actor, tool, args) });
  }
}
