import { actorFromRequest } from "@/lib/auth";
import { streamResponse } from "@/lib/stream-response";
import { openStream } from "@wheelhouse/core/lib/stream-open";
import { teamScope } from "@wheelhouse/core/lib/stream-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-sent changes across the signed-in user's whole team, for the dashboard (WH-1). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  return streamResponse(await openStream({ getActor: actorFromRequest, scopeFor: teamScope(), lastEventId: request.headers.get("last-event-id"), since: url.searchParams.get("since"), signal: request.signal }));
}
