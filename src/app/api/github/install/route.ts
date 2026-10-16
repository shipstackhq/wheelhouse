import { requireHuman } from "@/lib/auth";
import { connectResponse } from "@/lib/connect-response";
import { startConnect } from "@wheelhouse/core/lib/github/connect";

export const dynamic = "force-dynamic";

/** Start connecting GitHub for a project: owners only. Sends the person to GitHub to install the App, with a signed `state`. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const human = await requireHuman();
  return connectResponse(await startConnect(human, url.searchParams.get("project") ?? ""), url);
}
