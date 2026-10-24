import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { actorFromCredentials, SESSION_COOKIE } from "../modules/auth/auth-core";
import { clientIp } from "../common/rate-limit";
import { openStream } from "../platform/streams/stream-open";
import { teamScope, workspaceScope, type StreamScope } from "../platform/streams/stream-scope";
import type { Actor } from "../common/actor";
import { cookieValue, toHeaders } from "../common/http/cookies";
import { StreamRegistry } from "../platform/streams/stream.registry";

@Controller()
export class StreamController {
  constructor(@Inject(StreamRegistry) private readonly streams: StreamRegistry) {}

  /** Server-sent changes across the signed-in user's whole workspace, for the dashboard (WH-1). */
  @Get("api/stream")
  workspace(@Req() req: Request, @Res() res: Response) {
    return this.serve(req, res, workspaceScope());
  }

  /** Server-sent changes for one team (WH-1). */
  @Get("api/teams/:key/stream")
  team(@Param("key") key: string, @Req() req: Request, @Res() res: Response) {
    return this.serve(req, res, teamScope(key));
  }

  private async serve(req: Request, res: Response, scopeFor: (actor: Actor) => Promise<StreamScope>) {
    // The client going away ends the stream, which releases its slot and its listener on the event bus.
    const gone = new AbortController();
    const untrack = this.streams.track(gone);
    res.on("close", () => {
      gone.abort();
      untrack();
    });
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
