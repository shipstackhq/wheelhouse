import { openStream } from "@/lib/stream-route";
import { projectScope } from "@/lib/stream-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-sent changes for one project (WH-1). The browser re-reads the page when one arrives. */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return openStream(request, projectScope(key));
}
