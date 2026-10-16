import { NextResponse } from "next/server";
import { actorFromRequest, AuthError } from "@/lib/auth";
import { runTool } from "@wheelhouse/core/lib/tools";
import { ServiceError } from "@wheelhouse/core/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/<tool> with a JSON body of the tool's arguments. GET /api/v1 lists tools. */
export async function POST(req: Request, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params;
  try {
    const actor = await actorFromRequest();
    const args = await req.json().catch(() => ({}));
    return NextResponse.json({ data: await runTool(actor, tool, args) });
  } catch (e) {
    if (e instanceof AuthError)
      return NextResponse.json(
        { error: { code: e.status === 429 ? "rate_limited" : e.status === 403 ? "team_suspended" : "unauthorized", message: e.message } },
        { status: e.status, headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : undefined },
      );
    if (e instanceof ServiceError)
      return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: e.status });
    console.error("[api]", e);
    return NextResponse.json({ error: { code: "internal", message: "Internal error" } }, { status: 500 });
  }
}
