import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { actorFromCredentials, SESSION_COOKIE } from "@wheelhouse/core/lib/auth-core";
import { clientIp } from "@wheelhouse/core/lib/rate-limit";
import { openStream } from "@wheelhouse/core/lib/stream-open";
import { projectScope, teamScope, type StreamScope } from "@wheelhouse/core/lib/stream-scope";
import type { Actor } from "@wheelhouse/core/lib/access";
import { cookieValue, toHeaders } from "../http/util";

@Controller()
export class StreamController {
  /** Server-sent changes across the signed-in user's whole team, for the dashboard (WH-1). */
  @Get("api/stream")
  team(@Req() req: Request, @Res() res: Response) {
    return this.serve(req, res, teamScope());
  }

  /** Server-sent changes for one project (WH-1). */
  @Get("api/projects/:key/stream")
  project(@Param("key") key: string, @Req() req: Request, @Res() res: Response) {
    return this.serve(req, res, projectScope(key));
  }

  private async serve(req: Request, res: Response, scopeFor: (actor: Actor) => Promise<StreamScope>) {
    // The client going away ends the stream, which releases its slot and its listener on the event bus.
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const last = req.headers["last-event-id"];
    const r = await openStream({
      getActor: () => actorFromCredentials({ authorization: req.headers.authorization ?? null, sessionToken: cookieValue(req.headers.cookie, SESSION_COOKIE), ip: clientIp(toHeaders(req.headers)) }),
      scopeFor,
      lastEventId: Array.isArray(last) ? (last[0] ?? null) : (last ?? null),
      since: new URL(req.originalUrl, "http://localhost").searchParams.get("since"),
      signal: gone.signal,
    });
    if (!("body" in r)) {
      res.status(r.status).set(r.headers ?? {}).type("text/plain").send(r.text);
      return;
    }
    res.writeHead(200, r.headers);
    res.flushHeaders();
    Readable.fromWeb(r.body as never).pipe(res);
  }
}
