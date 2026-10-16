import { openStream } from "@/lib/stream-route";
import { teamScope } from "@wheelhouse/core/lib/stream-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-sent changes across the signed-in user's whole team, for the dashboard (WH-1). */
export async function GET(request: Request) {
  return openStream(request, teamScope());
}
