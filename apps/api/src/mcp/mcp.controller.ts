import { Catch, Controller, Delete, Get, Post, Req, Res, UseFilters, UseGuards, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { AuthError } from "../lib/access";
import { mcpAuthFailure } from "../lib/api-errors";
import { runMcp } from "../lib/mcp";
import { ActorGuard, type AuthedRequest } from "../auth/actor.guard";
import type { RawTextRequest } from "../http/raw-text";

/** Anything that goes wrong before the protocol takes over is answered as a JSON-RPC error. */
@Catch()
export class McpExceptionFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof AuthError) {
      const f = mcpAuthFailure(e);
      res.status(f.status).set(f.headers ?? {}).json(f.body);
      return;
    }
    console.error("[mcp]", e);
    res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
  }
}

/**
 * Stateless MCP over Streamable HTTP, JSON responses. The protocol is lib/mcp.ts's; every request is authenticated up
 * front (so a bad key fails at connect time) and the caller is resolved once, not again per tool call.
 */
@Controller("mcp")
@UseFilters(McpExceptionFilter)
export class McpController {
  @Post()
  @UseGuards(ActorGuard)
  async post(@Req() req: AuthedRequest & RawTextRequest, @Res() res: Response) {
    const actor = req.actor;
    const r = await runMcp(req.rawText ?? "", async () => actor);
    if (r.body === undefined) res.status(r.status).end();
    else res.status(r.status).json(r.body);
  }

  /** No server-initiated stream in this stateless server. */
  @Get()
  get(@Res() res: Response) {
    res.status(405).set("Allow", "POST").send("Method Not Allowed");
  }

  @Delete()
  delete(@Res() res: Response) {
    res.status(405).end();
  }
}
