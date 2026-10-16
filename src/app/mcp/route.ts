import { NextResponse } from "next/server";
import { actorFromRequest, AuthError } from "@/lib/auth";
import { mcpAuthFailure } from "@wheelhouse/core/lib/api-errors";
import { runMcp } from "@wheelhouse/core/lib/mcp";

/**
 * Stateless MCP server over Streamable HTTP (JSON responses, no SSE). The protocol lives in @wheelhouse/core/lib/mcp so the
 * API answers identically.
 *   claude mcp add --transport http wheelhouse https://<host>/mcp \
 *     --header "Authorization: Bearer wh_..."
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Authenticate every request up front so a bad key fails at connect time.
  try {
    await actorFromRequest();
  } catch (e) {
    if (e instanceof AuthError) {
      const f = mcpAuthFailure(e);
      return NextResponse.json(f.body, { status: f.status, headers: f.headers });
    }
    throw e;
  }
  const r = await runMcp(await req.text(), () => actorFromRequest());
  return r.body === undefined ? new Response(null, { status: r.status }) : NextResponse.json(r.body, { status: r.status });
}

export async function GET() {
  // No server-initiated SSE stream in this stateless server.
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405 });
}
