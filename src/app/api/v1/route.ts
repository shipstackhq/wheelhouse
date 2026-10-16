import { NextResponse } from "next/server";
import { listToolDefs } from "@wheelhouse/core/lib/tools";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    usage: "POST /api/v1/<name> with JSON body; Authorization: Bearer <api key>",
    tools: listToolDefs({ includeHidden: true }),
  });
}
