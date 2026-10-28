import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { text, textOrNull } from "../../common/http/web-input";
import type { Human } from "../auth/index";
import { TeamAccessService } from "../teams/index";
import type { GithubApi } from "./api";
import { githubConfig, githubMissing } from "./config";
import { GithubRepository } from "./github.repository";
import { RepositoriesService } from "./repositories.service";
import { github } from "./runtime";
import { makeState, readState, STATE_TTL_MS } from "./state";

type Body = Record<string, unknown>;

/** Paths are relative to the app (`/w/<slug>/settings/integrations/github?team=KEY&...`); the GitHub address is absolute. */
const integrationPage = (workspace: string, team: string, query = "") => `/w/${encodeURIComponent(workspace)}/settings/integrations/github?team=${encodeURIComponent(team)}${query ? `&${query}` : ""}`;

/** What the connect flow tells the host to send: the redirect or text, and the state cookie. */
export type ConnectReply = {
  status: number;
  redirect?: string;
  text?: string;
  /** Set the state cookie (the nonce) with these values. */
  setStateCookie?: { value: string; maxAgeSec: number };
  /** Delete the state cookie. */
  clearStateCookie?: boolean;
};

export type GithubStatus = {
  /** False when this server has no GitHub App; nothing below is then available. */
  configured: boolean;
  /** For owners only: the settings an administrator must set to turn it on. */
  missing: string[];
  isOwner: boolean;
  /** For everyone: the workspace has at least one GitHub App installation. */
  connected: boolean;
  /** Owners only: each installation of the workspace and the repositories it can see that this team has not connected yet. */
  installations: { installationId: string; account: string; failed: boolean; repositories: { id: string; fullName: string; private: boolean }[] }[];
};

/**
 * Connecting GitHub (WH-20, ADR-12): the owner's installation of the App, the repositories of it a team connects, and the redirect flow
 * that proves the installation is the person's. Only workspace owners connect, and an installation can serve several workspaces, each linked on its own proof.
 */
@Injectable()
export class ConnectService {
  constructor(
    @Inject(GithubRepository) private readonly repo: GithubRepository,
    @Inject(TeamAccessService) private readonly teams: TeamAccessService,
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
  ) {}

  private async requireOwner(userId: string, workspaceId: string) {
    if ((await this.repo.membershipRole(userId, workspaceId)) !== "owner") throw new ServiceError("forbidden", "Only workspace owners can connect GitHub");
  }

  /**
   * Record that this workspace's owner has installed the App. The caller has already proved, with GitHub's own sign-in, that this
   * person administers the installation. The link is this workspace's: other workspaces' links to it are untouched.
   */
  async registerInstallation(actor: Actor, i: { installationId: string; accountLogin: string; accountType: string }) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can connect GitHub");
    await this.requireOwner(actor.id, actor.workspaceId);
    await this.repo.upsertInstallation({ installationId: i.installationId, workspaceId: actor.workspaceId, accountLogin: i.accountLogin, accountType: i.accountType, connectedBy: actor.id });
    return { ok: true };
  }

  listInstallations(actor: Actor) {
    return this.repo.installationsOf(actor.workspaceId);
  }

  /** This workspace stops using an installation (owners only). Other workspaces linked to it keep it. */
  async unlinkInstallation(actor: Actor, installationId: string) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can disconnect GitHub");
    await this.requireOwner(actor.id, actor.workspaceId);
    if (!(await this.repo.installationOf(actor.workspaceId, installationId))) throw new ServiceError("not_found", "That GitHub installation is not connected to your workspace");
    await this.repo.unlinkInstallation(actor.workspaceId, installationId);
    return { ok: true };
  }

  /**
   * Connect one repository of one of the workspace's installations to a team. The repository's name and default branch are
   * read from GitHub, not taken from the request, so what is stored is what GitHub says about a repository the installation
   * can really see.
   */
  async connectGithubRepository(
    actor: Actor,
    teamRef: string,
    i: { installationId: string; githubRepoId: string; role: string; pathLimit?: string | null },
    api: GithubApi | null,
  ) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can connect repositories");
    await this.requireOwner(actor.id, actor.workspaceId);
    if (!api) throw new ServiceError("invalid", "The GitHub App is not configured on this server");
    const team = await this.teams.require(actor, teamRef);
    // The installation must be this workspace's own: otherwise a repository id from someone else's installation would feed their pushes here.
    if (!(await this.repo.installationOf(actor.workspaceId, i.installationId))) throw new ServiceError("forbidden", "That GitHub installation is not connected to your workspace");
    const visible = await api.installationRepositories(i.installationId);
    const gh = visible.find((r) => r.id === i.githubRepoId);
    if (!gh) throw new ServiceError("not_found", "GitHub does not list that repository for this installation");
    if (await this.repo.findRepositoryByGithubId(team.id, gh.id)) throw new ServiceError("conflict", `${gh.fullName} is already connected to this team`);
    return this.repositories.createRepository(actor, teamRef, {
      displayName: gh.fullName.split("/").pop() || gh.fullName,
      role: i.role,
      provider: "github",
      githubRepoId: gh.id,
      githubInstallationId: i.installationId,
      githubFullName: gh.fullName,
      defaultBranch: gh.defaultBranch,
      pathLimit: i.pathLimit ?? null,
    });
  }

  /** Owners only (checked in connectGithubRepository). Name and branch are read from GitHub, and the installation must be the workspace's own (ADR-12). */
  connectGithubAs(actor: Actor, teamKey: string, b: Body) {
    const installationId = text(b, "installationId", { required: true, max: 100 })!;
    const githubRepoId = text(b, "repoId", { required: true, max: 100 })!;
    const role = text(b, "role", { max: 100, trim: true }) || "code";
    const pathLimit = textOrNull(b, "pathLimit");
    return this.connectGithubRepository(actor, teamKey, { installationId, githubRepoId, role, pathLimit: pathLimit?.trim() || null }, github()?.api ?? null);
  }

  async githubStatus(h: Human, teamKey: string): Promise<GithubStatus> {
    const isOwner = h.membership.role === "owner";
    const connected = (await this.repositories.listRepositories(h.actor, teamKey)).map((r) => r.githubRepoId).filter((x): x is string => !!x);
    const gh = github();
    if (!githubConfig() || !gh) return { configured: false, missing: isOwner ? githubMissing() : [], isOwner, connected: false, installations: [] };
    // Whether the workspace is connected is for everyone; which installations and repositories, for owners only.
    const linked = await this.listInstallations(h.actor);
    const installs = isOwner ? linked : [];
    const installations: GithubStatus["installations"] = [];
    for (const i of installs) {
      try {
        const repos = (await gh.api.installationRepositories(i.installationId)).filter((r) => !connected.includes(r.id));
        installations.push({ installationId: i.installationId, account: i.accountLogin, failed: false, repositories: repos.map((r) => ({ id: r.id, fullName: r.fullName, private: r.private })) });
      } catch {
        installations.push({ installationId: i.installationId, account: i.accountLogin, failed: true, repositories: [] });
      }
    }
    return { configured: true, missing: [], isOwner, connected: linked.length > 0, installations };
  }

  /** Start connecting: owners only. Sends the person to GitHub to install the App, with a signed `state`. */
  async startConnect(h: Human, teamKey: string): Promise<ConnectReply> {
    const cfg = githubConfig();
    const back = (err: string): ConnectReply => ({ status: 307, redirect: integrationPage(h.workspace.slug, teamKey, `github_error=${err}`) });
    if (!cfg) return back("not_configured");
    if (h.membership.role !== "owner") return back("owner_only");
    try {
      await this.teams.require(h.actor, teamKey);
    } catch (e) {
      if (e instanceof ServiceError) return { status: 404, text: "Not found" };
      throw e;
    }
    const { state, nonce } = makeState(cfg.clientSecret, { user: h.user.id, workspace: h.workspace.slug, team: teamKey });
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
  async finishConnect(h: Human, q: { state: string | null; installationId: string | null; code: string | null }, nonce: string | undefined): Promise<ConnectReply> {
    const gh = github();
    const state = gh ? readState(gh.cfg.clientSecret, q.state) : null;
    const team = state?.team ?? "";
    const back = (err?: string, extra = ""): ConnectReply => ({
      status: 307,
      clearStateCookie: true,
      redirect: integrationPage(h.workspace.slug, team, err ? `github_error=${err}` : extra),
    });
    if (!gh) return { status: 503, text: "The GitHub App is not configured on this server", clearStateCookie: true };
    if (!state || state.user !== h.user.id || state.workspace !== h.workspace.slug || !nonce || nonce !== state.nonce)
      return { status: 400, text: "This connection link is not valid any more. Start again from Settings → Integrations → GitHub.", clearStateCookie: true };
    if (h.membership.role !== "owner") return back("owner_only");

    const installationId = q.installationId ?? "";
    if (!/^\d{1,20}$/.test(installationId)) return back("bad_installation");
    if (!q.code) return back("no_code"); // the App must have "Request user authorization (OAuth) during installation" switched on
    try {
      const mine = await gh.api.userInstallationIds(q.code);
      if (!mine.includes(installationId)) return back("not_yours");
      const account = await gh.api.installationAccount(installationId);
      await this.registerInstallation(h.actor, { installationId, accountLogin: account.login, accountType: account.type });
    } catch (e) {
      if (e instanceof ServiceError) return back("failed");
      console.error("[github] callback failed:", e instanceof Error ? e.message : e);
      return back("failed");
    }
    return back(undefined, "github=connected");
  }
}
