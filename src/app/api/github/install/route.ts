import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { requireHuman } from "@/lib/auth";
import { getProject, ServiceError } from "@/lib/service";
import { githubConfig } from "@/lib/github/config";
import { makeState, STATE_COOKIE, STATE_TTL_MS } from "@/lib/github/state";

export const dynamic = "force-dynamic";


/** Start connecting GitHub for a project: owners only. Sends the person to GitHub to install the App, with a signed `state`. */
export async function GET(request: Request) {
  const cfg = githubConfig();
  const url = new URL(request.url);
  const projectKey = url.searchParams.get("project") ?? "";
  const { user, membership, actor } = await requireHuman();
  const back = (err: string) => NextResponse.redirect(new URL(`/p/${encodeURIComponent(projectKey)}/repos?github_error=${err}`, url));
  if (!cfg) return back("not_configured");
  if (membership.role !== "owner") return back("owner_only");
  try {
    await getProject(actor, projectKey);
  } catch (e) {
    if (e instanceof ServiceError) return new NextResponse("Not found", { status: 404 });
    throw e;
  }
  const { state, nonce } = makeState(cfg.clientSecret, { user: user.id, project: projectKey });
  (await cookies()).set(STATE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/github", maxAge: Math.floor(STATE_TTL_MS / 1000) });
  return NextResponse.redirect(`${cfg.webUrl}/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${encodeURIComponent(state)}`);
}
