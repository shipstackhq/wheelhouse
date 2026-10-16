import { NextResponse } from "next/server";
import { actorFromRequest } from "@/lib/auth";
import { runTool } from "@wheelhouse/core/lib/tools";
import { v1Failure } from "@wheelhouse/core/lib/api-errors";

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
    const f = v1Failure(e);
    return NextResponse.json(f.body, { status: f.status, headers: f.headers });
  }
}
