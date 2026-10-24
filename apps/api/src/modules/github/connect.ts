import type { Human } from "../auth/auth-core";
import { requireTeam, ServiceError } from "../../lib/service";
import { githubConfig } from "./config";
import { github } from "./runtime";
import { makeState, readState, STATE_TTL_MS } from "./state";
import { registerInstallation } from "./service";

/**
 * Connecting GitHub for a team (WH-20, ADR-12). Each function returns what the host should send; the host does the
 * redirect and the cookie. Paths are relative to the app (`/settings/integrations/github?team=KEY&...`); the GitHub address is absolute.
 */
const integrationPage = (team: string, query = "") => `/settings/integrations/github?team=${encodeURIComponent(team)}${query ? `&${query}` : ""}`;

export type ConnectReply = {
  status: number;
  redirect?: string;
  text?: string;
  /** Set the state cookie (the nonce) with these values. */
  setStateCookie?: { value: string; maxAgeSec: number };
  /** Delete the state cookie. */
  clearStateCookie?: boolean;
};

/** Start connecting: owners only. Sends the person to GitHub to install the App, with a signed `state`. */
export async function startConnect(h: Human, teamKey: string): Promise<ConnectReply> {
  const cfg = githubConfig();
  const back = (err: string): ConnectReply => ({ status: 307, redirect: integrationPage(teamKey, `github_error=${err}`) });
  if (!cfg) return back("not_configured");
  if (h.membership.role !== "owner") return back("owner_only");
  try {
    await requireTeam(h.actor, teamKey);
  } catch (e) {
    if (e instanceof ServiceError) return { status: 404, text: "Not found" };
    throw e;
  }
  const { state, nonce } = makeState(cfg.clientSecret, { user: h.user.id, team: teamKey });
  return {
    status: 307,
    redirect: `${cfg.webUrl}/apps/${encodeURIComponent(cfg.slug)}/installations/new?state=${encodeURIComponent(state)}`,
    setStateCookie: { value: nonce, maxAgeSec: Math.floor(STATE_TTL_MS / 1000) },
  };
}

/**
 * Where GitHub sends people after they install the App. The installation id in the address is just a number anyone could
 * type, so it is only trusted after (1) the signed state proves this person started the flow in this browser and (2)
 * GitHub itself says, for the `code` it just issued, that this person can administer that installation. The state cookie is
 * always cleared: a link works once.
 */
export async function finishConnect(h: Human, q: { state: string | null; installationId: string | null; code: string | null }, nonce: string | undefined): Promise<ConnectReply> {
  const gh = github();
  const state = gh ? readState(gh.cfg.clientSecret, q.state) : null;
  const team = state?.team ?? "";
  const back = (err?: string, extra = ""): ConnectReply => ({
    status: 307,
    clearStateCookie: true,
    redirect: integrationPage(team, err ? `github_error=${err}` : extra),
  });
  if (!gh) return { status: 503, text: "The GitHub App is not configured on this server", clearStateCookie: true };
  if (!state || state.user !== h.user.id || !nonce || nonce !== state.nonce)
    return { status: 400, text: "This connection link is not valid any more. Start again from Settings → Integrations → GitHub.", clearStateCookie: true };
  if (h.membership.role !== "owner") return back("owner_only");

  const installationId = q.installationId ?? "";
  if (!/^\d{1,20}$/.test(installationId)) return back("bad_installation");
  if (!q.code) return back("no_code"); // the App must have "Request user authorization (OAuth) during installation" switched on
  try {
    const mine = await gh.api.userInstallationIds(q.code);
    if (!mine.includes(installationId)) return back("not_yours");
    const account = await gh.api.installationAccount(installationId);
    await registerInstallation(h.actor, { installationId, accountLogin: account.login, accountType: account.type });
  } catch (e) {
    if (e instanceof ServiceError) return back(e.code === "conflict" ? "taken" : "failed");
    console.error("[github] callback failed:", e instanceof Error ? e.message : e);
    return back("failed");
  }
  return back(undefined, "github=connected");
}
