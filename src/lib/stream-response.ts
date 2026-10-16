import type { StreamResult } from "@wheelhouse/core/lib/stream-open";

/** A Next response for what openStream decided: the event stream, or a short refusal. */
export function streamResponse(r: StreamResult) {
  return "body" in r ? new Response(r.body, { headers: r.headers }) : new Response(r.text, { status: r.status, headers: r.headers });
}
