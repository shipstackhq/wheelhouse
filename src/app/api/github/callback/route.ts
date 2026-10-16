import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireHuman } from "@/lib/auth";
import { ServiceError } from "@wheelhouse/core/lib/service";
import { github } from "@wheelhouse/core/lib/github/runtime";
import { readState, STATE_COOKIE } from "@wheelhouse/core/lib/github/state";
import { registerInstallation } from "@wheelhouse/core/lib/github/service";

export const dynamic = "force-dynamic";

/**
 * Where GitHub sends people after they install the App. The installation id in the address is just a number anyone could
 * type, so it is only trusted after (1) the signed state proves this person started the flow in this browser and (2)
 * GitHub itself says, for the `code` it just issued, that this person can administer that installation.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gh = github();
  const { user, membership, actor } = await requireHuman();
  const jar = await cookies();
  const nonce = jar.get(STATE_COOKIE)?.value;
  jar.delete({ name: STATE_COOKIE, path: "/api/github" });

  const state = gh ? readState(gh.cfg.clientSecret, url.searchParams.get("state")) : null;
  const project = state?.project ?? "";
  const back = (err?: string, extra = "") => NextResponse.redirect(new URL(`/p/${encodeURIComponent(project)}/repos${err ? `?github_error=${err}` : extra ? `?${extra}` : ""}`, url));
  if (!gh) return new NextResponse("The GitHub App is not configured on this server", { status: 503 });
  if (!state || state.user !== user.id || !nonce || nonce !== state.nonce) return new NextResponse("This connection link is not valid any more. Start again from the project's Repositories page.", { status: 400 });
  if (membership.role !== "owner") return back("owner_only");

  const installationId = url.searchParams.get("installation_id") ?? "";
  const code = url.searchParams.get("code");
  if (!/^\d{1,20}$/.test(installationId)) return back("bad_installation");
  if (!code) return back("no_code"); // the App must have "Request user authorization (OAuth) during installation" switched on
  try {
    const mine = await gh.api.userInstallationIds(code);
    if (!mine.includes(installationId)) return back("not_yours");
    const account = await gh.api.installationAccount(installationId);
    await registerInstallation(actor, { installationId, accountLogin: account.login, accountType: account.type });
  } catch (e) {
    if (e instanceof ServiceError) return back(e.code === "conflict" ? "taken" : "failed");
    console.error("[github] callback failed:", e instanceof Error ? e.message : e);
    return back("failed");
  }
  return back(undefined, "github=connected");
}
