import { cookies } from "next/headers";
import { requireHuman } from "@/lib/auth";
import { connectResponse } from "@/lib/connect-response";
import { finishConnect } from "@wheelhouse/core/lib/github/connect";
import { STATE_COOKIE } from "@wheelhouse/core/lib/github/state";

export const dynamic = "force-dynamic";

/** Where GitHub sends people after they install the App. The checks that make the installation id trustworthy are in @wheelhouse/core. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const human = await requireHuman();
  const nonce = (await cookies()).get(STATE_COOKIE)?.value;
  const q = { state: url.searchParams.get("state"), installationId: url.searchParams.get("installation_id"), code: url.searchParams.get("code") };
  return connectResponse(await finishConnect(human, q, nonce), url);
}
