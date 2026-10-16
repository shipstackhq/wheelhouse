import { actorFromRequest } from "@/lib/auth";
import { streamResponse } from "@/lib/stream-response";
import { openStream } from "@wheelhouse/core/lib/stream-open";
import { projectScope } from "@wheelhouse/core/lib/stream-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-sent changes for one project (WH-1). The browser re-reads the page when one arrives. */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const url = new URL(request.url);
  return streamResponse(await openStream({ getActor: actorFromRequest, scopeFor: projectScope(key), lastEventId: request.headers.get("last-event-id"), since: url.searchParams.get("since"), signal: request.signal }));
}
