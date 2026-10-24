import { schema } from "../../db";
import type { Actor } from "../../common/actor";
import type { Human } from "../../lib/auth-core";
import { githubConfig, githubMissing } from "./config";
import { github } from "./runtime";
import { connectGithubRepository, listInstallations } from "./service";
import { onboarding } from "@wheelhouse/shared/onboarding";
import * as svc from "../../lib/service";
import { ServiceError } from "../../lib/service";
import { bad, oneOf, text, textOrNull } from "../../lib/web-input";

/**
 * What the web app's docs, repositories and onboarding pages read and write (WH-98), as functions of the signed-in person.
 * The API's controllers call these and nothing else. Everything goes through the service layer, which scopes it by the person's
 * workspace, so another workspace's team, doc or repository is "not found". Answers carry only what the screens use.
 */

type Body = Record<string, unknown>;

// ───────── repositories ─────────

export type RepositoryView = {
  id: string;
  displayName: string;
  role: string;
  provider: "github" | "local";
  slug: string;
  githubFullName: string | null;
  defaultBranch: string;
  pathLimit: string | null;
  lifecycle: (typeof schema.REPO_LIFECYCLES)[number];
  lastEventAt: Date | null;
  /** True when its file tree can be browsed (a GitHub repository with its installation), for the doc anchor picker. */
  browsable: boolean;
};

export const repositoryView = (r: typeof schema.repositories.$inferSelect): RepositoryView => ({
  id: r.id,
  displayName: r.displayName,
  role: r.role,
  provider: r.provider,
  slug: r.slug,
  githubFullName: r.githubFullName,
  defaultBranch: r.defaultBranch,
  pathLimit: r.pathLimit,
  lifecycle: r.lifecycle,
  lastEventAt: r.lastEventAt,
  browsable: r.provider === "github" && !!r.githubInstallationId && !!r.githubRepoId,
});

export async function listRepositoriesAs(actor: Actor, teamKey: string): Promise<RepositoryView[]> {
  return (await svc.listRepositories(actor, teamKey)).map(repositoryView);
}

function repositoryFields(b: Body, creating: boolean): Partial<svc.RepositoryInput> {
  const displayName = text(b, "displayName", { required: creating, max: 200 });
  const role = text(b, "role", { required: creating, max: 100 });
  if (displayName !== undefined && !displayName.trim()) bad("displayName", "displayName is required");
  if (role !== undefined && !role.trim()) bad("role", "role is required");
  const out: Partial<svc.RepositoryInput> = {
    displayName,
    role,
    provider: oneOf(b, "provider", schema.REPO_PROVIDERS),
    defaultBranch: text(b, "defaultBranch", { max: 200 }),
    pathLimit: textOrNull(b, "pathLimit"),
    lifecycle: oneOf(b, "lifecycle", schema.REPO_LIFECYCLES),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export async function createRepositoryAs(actor: Actor, teamKey: string, b: Body): Promise<RepositoryView> {
  return repositoryView(await svc.createRepository(actor, teamKey, repositoryFields(b, true) as svc.RepositoryInput));
}

export async function updateRepositoryAs(actor: Actor, teamKey: string, id: string, b: Body): Promise<RepositoryView> {
  return repositoryView(await svc.updateRepository(actor, teamKey, id, repositoryFields(b, false)));
}

export async function retireRepositoryAs(actor: Actor, teamKey: string, id: string): Promise<RepositoryView> {
  return repositoryView(await svc.retireRepository(actor, teamKey, id));
}

/**
 * The file paths of a connected GitHub repository's default branch, for the doc anchor picker. Read-only. The repository is looked up
 * in the person's own team, so an id from another workspace's team never matches and is "not found", never another workspace's tree.
 */
export async function browseRepoTreeAs(actor: Actor, teamKey: string, id: string) {
  const repo = (await svc.listRepositories(actor, teamKey)).find((r) => r.id === id);
  if (!repo) throw new ServiceError("not_found", `Repository "${id}" not found`);
  if (repo.provider !== "github" || !repo.githubInstallationId || !repo.githubRepoId) throw new ServiceError("invalid", "This repository is not connected to GitHub");
  const gh = github();
  if (!gh) throw new ServiceError("invalid", "GitHub is not set up on this server");
  const { files, truncated } = await gh.api.treeAt(repo.githubInstallationId, repo.githubRepoId, repo.defaultBranch || "main");
  return { files: files.map((f) => f.path), truncated };
}

// ───────── connecting GitHub ─────────

export type GithubStatus = {
  /** False when this server has no GitHub App; nothing below is then available. */
  configured: boolean;
  /** For owners only: the settings an administrator must set to turn it on. */
  missing: string[];
  isOwner: boolean;
  /** Owners only: each installation of the workspace and the repositories it can see that this team has not connected yet. */
  installations: { installationId: string; account: string; failed: boolean; repositories: { id: string; fullName: string; private: boolean }[] }[];
};

export async function githubStatus(h: Human, teamKey: string): Promise<GithubStatus> {
  const isOwner = h.membership.role === "owner";
  const connected = (await svc.listRepositories(h.actor, teamKey)).map((r) => r.githubRepoId).filter((x): x is string => !!x);
  const gh = github();
  if (!githubConfig() || !gh) return { configured: false, missing: isOwner ? githubMissing() : [], isOwner, installations: [] };
  const installs = isOwner ? await listInstallations(h.actor) : [];
  const installations: GithubStatus["installations"] = [];
  for (const i of installs) {
    try {
      const repos = (await gh.api.installationRepositories(i.installationId)).filter((r) => !connected.includes(r.id));
      installations.push({ installationId: i.installationId, account: i.accountLogin, failed: false, repositories: repos.map((r) => ({ id: r.id, fullName: r.fullName, private: r.private })) });
    } catch {
      installations.push({ installationId: i.installationId, account: i.accountLogin, failed: true, repositories: [] });
    }
  }
  return { configured: true, missing: [], isOwner, installations };
}

/** Owners only (checked in the service). Name and branch are read from GitHub, and the installation must be the workspace's own (ADR-12). */
export async function connectGithubAs(actor: Actor, teamKey: string, b: Body): Promise<RepositoryView> {
  const installationId = text(b, "installationId", { required: true, max: 100 })!;
  const githubRepoId = text(b, "repoId", { required: true, max: 100 })!;
  const role = text(b, "role", { max: 100, trim: true }) || "code";
  const pathLimit = textOrNull(b, "pathLimit");
  const repo = await connectGithubRepository(actor, teamKey, { installationId, githubRepoId, role, pathLimit: pathLimit?.trim() || null }, github()?.api ?? null);
  return repositoryView(repo);
}

// ───────── onboarding ─────────

/** The wizard: the team, whether it already has a repository, and the commands to paste (with this team's key in them). */
export async function onboardingPage(actor: Actor, teamKey: string, origin: string) {
  const team = await svc.requireTeam(actor, teamKey);
  const repos = await svc.listRepositories(actor, teamKey);
  return { team: { key: team.key, name: team.name }, hasRepos: repos.length > 0, setup: onboarding({ origin, teamKey }) };
}

/**
 * The "no code yet" path: a few sentences about what is being built become the first concept on the map, so a team with no
 * repository still has something there.
 */
export async function createConceptAs(actor: Actor, teamKey: string, b: Body) {
  const description = text(b, "description", { max: 20_000, trim: true });
  if (!description) bad("description", "Write a few sentences about what you're building.");
  const team = await svc.requireTeam(actor, teamKey, "edit");
  await svc.upsertNode(actor, teamKey, { name: team.name, layer: "concept", kind: "concept", summary: description!.slice(0, 200), purpose: description });
  return { ok: true as const };
}
