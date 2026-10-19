import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import type { Human } from "./auth-core";
import { DOC_TEMPLATE_IDS } from "./doc-templates";
import { githubConfig, githubMissing } from "./github/config";
import { github } from "./github/runtime";
import { connectGithubRepository, listInstallations } from "./github/service";
import { onboarding } from "./onboarding";
import * as svc from "./service";
import { ServiceError } from "./service";
import { bad, oneOf, text, textList, textOrNull, whole } from "./web-input";

/**
 * What the web app's docs, repositories and onboarding pages read and write (WH-98), as functions of the signed-in person.
 * The API's controllers call these and nothing else. Everything goes through the service layer, which scopes it by the person's
 * workspace, so another workspace's project, doc or repository is "not found". Answers carry only what the screens use.
 */

type Body = Record<string, unknown>;

// ───────── docs ─────────

export type DocTreeItem = { id: string; parentId: string | null; slug: string; title: string; version: number; position: number; updatedAt: Date; stale: boolean };

export type DocView = DocTreeItem & {
  body: string;
  anchors: string[];
  labels: string[];
  staleReason: string | null;
  updatedByKind: "human" | "agent";
  updatedById: string | null;
  createdAt: Date;
};

export const docView = (d: typeof schema.docs.$inferSelect): DocView => ({
  id: d.id,
  parentId: d.parentId,
  slug: d.slug,
  title: d.title,
  version: d.version,
  position: d.position,
  updatedAt: d.updatedAt,
  stale: d.stale,
  body: d.body,
  anchors: d.anchors,
  labels: d.labels,
  staleReason: d.staleReason,
  updatedByKind: d.updatedByKind,
  updatedById: d.updatedById,
  createdAt: d.createdAt,
});

/** A stale `version` is a 409 whose `details.current` is the doc as it is now, in the same trimmed shape as every other answer. */
async function withCurrent<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") {
      const raw = (e.details as { current?: typeof schema.docs.$inferSelect } | undefined)?.current;
      if (raw) throw new ServiceError("conflict", e.message, { current: docView(raw) });
    }
    throw e;
  }
}

/** The docs page in one read: the tree, and what its side panels offer (map nodes to link, decisions to link, who wrote what). */
export async function docsIndex(h: Human, projectKey: string) {
  const [docs, g] = await Promise.all([svc.listDocs(h.actor, projectKey), svc.getGraph(h.actor, projectKey)]);
  const db = await getDb();
  const members = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.workspaceId, h.workspace.id));
  return {
    docs: docs as DocTreeItem[],
    nodes: g.nodes.map(({ id, name, layer, parentId }) => ({ id, name, layer, parentId })),
    decisions: g.decisions.map(({ id, number, title }) => ({ id, number, title })),
    members,
  };
}

export async function getDocAs(actor: Actor, projectKey: string, ref: string) {
  const { doc, nodes, owner, contributors } = await svc.getDoc(actor, projectKey, ref);
  return { doc: docView(doc), nodes, owner, contributors };
}

export async function createDocAs(actor: Actor, projectKey: string, b: Body): Promise<DocView> {
  const title = text(b, "title", { required: true, max: 300, trim: true })!;
  const input: svc.DocInput & { title: string } = {
    title,
    body: text(b, "body"),
    parent: textOrNull(b, "parent"),
    template: oneOf(b, "template", DOC_TEMPLATE_IDS),
  };
  return docView(await svc.createDoc(actor, projectKey, input));
}

/** `version` is the lock: a change made since is a 409 and nothing is overwritten. */
export async function updateDocAs(actor: Actor, projectKey: string, ref: string, b: Body): Promise<DocView> {
  const anchors = textList(b, "anchors");
  const patch = {
    title: text(b, "title", { max: 300 }),
    body: text(b, "body"),
    anchors: anchors?.map((a) => a.trim()).filter(Boolean),
    labels: textList(b, "labels"),
  };
  if (patch.title !== undefined && !patch.title.trim()) bad("title", "title is required");
  return docView(await withCurrent(() => svc.updateDoc(actor, projectKey, ref, patch, whole(b, "version"))));
}

export async function markDocFreshAs(actor: Actor, projectKey: string, ref: string): Promise<DocView> {
  return docView(await svc.markDocFresh(actor, projectKey, ref));
}

export async function moveDocAs(actor: Actor, projectKey: string, ref: string, b: Body): Promise<DocView> {
  const opts = { parent: textOrNull(b, "parent"), index: whole(b, "index") };
  return docView(await withCurrent(() => svc.moveDoc(actor, projectKey, ref, opts, whole(b, "version"))));
}

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

export async function listRepositoriesAs(actor: Actor, projectKey: string): Promise<RepositoryView[]> {
  return (await svc.listRepositories(actor, projectKey)).map(repositoryView);
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

export async function createRepositoryAs(actor: Actor, projectKey: string, b: Body): Promise<RepositoryView> {
  return repositoryView(await svc.createRepository(actor, projectKey, repositoryFields(b, true) as svc.RepositoryInput));
}

export async function updateRepositoryAs(actor: Actor, projectKey: string, id: string, b: Body): Promise<RepositoryView> {
  return repositoryView(await svc.updateRepository(actor, projectKey, id, repositoryFields(b, false)));
}

export async function retireRepositoryAs(actor: Actor, projectKey: string, id: string): Promise<RepositoryView> {
  return repositoryView(await svc.retireRepository(actor, projectKey, id));
}

/**
 * The file paths of a connected GitHub repository's default branch, for the doc anchor picker. Read-only. The repository is looked up
 * in the person's own project, so an id from another workspace's project never matches and is "not found", never another workspace's tree.
 */
export async function browseRepoTreeAs(actor: Actor, projectKey: string, id: string) {
  const repo = (await svc.listRepositories(actor, projectKey)).find((r) => r.id === id);
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
  /** Owners only: each installation of the workspace and the repositories it can see that this project has not connected yet. */
  installations: { installationId: string; account: string; failed: boolean; repositories: { id: string; fullName: string; private: boolean }[] }[];
};

export async function githubStatus(h: Human, projectKey: string): Promise<GithubStatus> {
  const isOwner = h.membership.role === "owner";
  const connected = (await svc.listRepositories(h.actor, projectKey)).map((r) => r.githubRepoId).filter((x): x is string => !!x);
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
export async function connectGithubAs(actor: Actor, projectKey: string, b: Body): Promise<RepositoryView> {
  const installationId = text(b, "installationId", { required: true, max: 100 })!;
  const githubRepoId = text(b, "repoId", { required: true, max: 100 })!;
  const role = text(b, "role", { max: 100, trim: true }) || "code";
  const pathLimit = textOrNull(b, "pathLimit");
  const repo = await connectGithubRepository(actor, projectKey, { installationId, githubRepoId, role, pathLimit: pathLimit?.trim() || null }, github()?.api ?? null);
  return repositoryView(repo);
}

// ───────── onboarding ─────────

/** The wizard: the project, whether it already has a repository, and the commands to paste (with this project's key in them). */
export async function onboardingPage(actor: Actor, projectKey: string, origin: string) {
  const project = await svc.getProject(actor, projectKey);
  const repos = await svc.listRepositories(actor, projectKey);
  return { project: { key: project.key, name: project.name }, hasRepos: repos.length > 0, setup: onboarding({ origin, projectKey }) };
}

/**
 * The "no code yet" path: a few sentences about what is being built become the first concept on the map, so a project with no
 * repository still has something there.
 */
export async function createConceptAs(actor: Actor, projectKey: string, b: Body) {
  const description = text(b, "description", { max: 20_000, trim: true });
  if (!description) bad("description", "Write a few sentences about what you're building.");
  const project = await svc.getProject(actor, projectKey, "edit");
  await svc.upsertNode(actor, projectKey, { name: project.name, layer: "concept", kind: "concept", summary: description!.slice(0, 200), purpose: description });
  return { ok: true as const };
}
