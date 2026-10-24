import { Inject, Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { bad, oneOf, text, textOrNull } from "../../lib/web-input";
import { EventsService } from "../../platform/events/events.service";
import { TeamAccessService } from "../teams/index";
import { REPOSITORY_CHANGED, type RepositoryChanged } from "./github.events";
import { GithubRepository, type RepositoryRow } from "./github.repository";
import { github } from "./runtime";

export type RepositoryInput = {
  displayName: string;
  role: string;
  provider?: (typeof schema.REPO_PROVIDERS)[number];
  slug?: string;
  githubRepoId?: string | null;
  githubInstallationId?: string | null;
  githubFullName?: string | null;
  defaultBranch?: string;
  pathLimit?: string | null;
  lifecycle?: (typeof schema.REPO_LIFECYCLES)[number];
};

type Body = Record<string, unknown>;

export const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";

/**
 * A team's repositories (WH-68): linked by hand, connected through GitHub or registered by a client report; each has a system node on
 * the map. Owners manage them (see createIssue for the human/agent split used elsewhere). Also the onboarding wizard's data and its
 * "first concept", which belong to the map and move with it. Every method resolves the team through TeamAccessService, so another
 * workspace's team or repository is "not found". The `...As` methods take the request body as the web app sends it and check it.
 */
@Injectable()
export class RepositoriesService {
  constructor(
    @Inject(GithubRepository) private readonly repo: GithubRepository,
    @Inject(TeamAccessService) private readonly teams: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
  ) {}

  /** A repository has a system node on the map; the map module keeps it (REPOSITORY_CHANGED, see github.events.ts). */
  private async systemNode(actor: Actor, teamId: string, repository: RepositoryRow) {
    await this.emitter.emitAsync(REPOSITORY_CHANGED, { actor, teamId, repository } satisfies RepositoryChanged);
  }

  async listRepositories(actor: Actor, teamRef: string) {
    const team = await this.teams.require(actor, teamRef);
    return this.repo.listRepositories(team.id);
  }

  private async resolve(teamId: string, ref: string) {
    const r = await this.repo.findRepository(teamId, isUuid(ref) ? { id: ref } : { slug: ref });
    if (!r) throw new ServiceError("not_found", `Repository "${ref}" not found`);
    return r;
  }

  async createRepository(actor: Actor, teamRef: string, input: RepositoryInput) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can add repositories");
    const team = await this.teams.require(actor, teamRef, "edit");
    if (!input.displayName?.trim()) throw new ServiceError("invalid", "displayName is required");
    if (!input.role?.trim()) throw new ServiceError("invalid", "role is required");
    const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.displayName);
    if (await this.repo.findRepository(team.id, { slug })) throw new ServiceError("conflict", `A repository with slug "${slug}" already exists on this team`);
    const r = await this.repo.insertRepository({
      teamId: team.id,
      workspaceId: team.workspaceId,
      displayName: input.displayName.trim(),
      role: input.role.trim(),
      provider: input.provider ?? "local",
      slug,
      githubRepoId: input.githubRepoId ?? null,
      githubInstallationId: input.githubInstallationId ?? null,
      githubFullName: input.githubFullName ?? null,
      defaultBranch: input.defaultBranch?.trim() || "main",
      pathLimit: input.pathLimit?.trim() || null,
      lifecycle: input.lifecycle ?? "live",
    });
    await this.events.emit(actor, team.id, { type: "repository.created", entity: "team", entityId: r.id, summary: `added repository "${r.displayName}" (${r.role})` });
    await this.systemNode(actor, team.id, r);
    return r;
  }

  async updateRepository(actor: Actor, teamRef: string, ref: string, patch: Partial<RepositoryInput>) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can edit repositories");
    const team = await this.teams.require(actor, teamRef, "edit");
    const existing = await this.resolve(team.id, ref);
    const set: Partial<typeof schema.repositories.$inferInsert> = { updatedAt: new Date() };
    if (patch.displayName !== undefined) set.displayName = patch.displayName.trim();
    if (patch.role !== undefined) set.role = patch.role.trim();
    if (patch.provider !== undefined) set.provider = patch.provider;
    if (patch.githubRepoId !== undefined) set.githubRepoId = patch.githubRepoId;
    if (patch.githubInstallationId !== undefined) set.githubInstallationId = patch.githubInstallationId;
    if (patch.defaultBranch !== undefined) set.defaultBranch = patch.defaultBranch.trim() || "main";
    if (patch.pathLimit !== undefined) set.pathLimit = patch.pathLimit?.trim() || null;
    if (patch.lifecycle !== undefined) set.lifecycle = patch.lifecycle;
    const r = await this.repo.updateRepository(existing.id, set);
    await this.events.emit(actor, team.id, { type: "repository.updated", entity: "team", entityId: r.id, summary: `updated repository "${r.displayName}"` });
    if (patch.lifecycle !== undefined && patch.lifecycle !== existing.lifecycle) await this.systemNode(actor, team.id, r);
    return r;
  }

  /** Retire a repository (soft: lifecycle -> retired). Never deletes landed history (team_files rows keep their repositoryId). */
  async retireRepository(actor: Actor, teamRef: string, ref: string) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can retire repositories");
    const team = await this.teams.require(actor, teamRef, "edit");
    const existing = await this.resolve(team.id, ref);
    const r = await this.repo.updateRepository(existing.id, { lifecycle: "retired", updatedAt: new Date() });
    await this.events.emit(actor, team.id, { type: "repository.retired", entity: "team", entityId: r.id, summary: `retired repository "${r.displayName}"` });
    await this.systemNode(actor, team.id, r);
    return r;
  }

  /**
   * Find-or-create used by the file-reporting path (wheelhouse.json names its repository on report;
   * a repo linked locally before this change registers automatically on its next report). `ref` is the
   * repo slug/name (or github id) the client sends; omitted falls back to a team-default row so old
   * CLI versions / repos without wheelhouse.json repo info keep reporting unqualified, as before.
   */
  async findOrCreateRepository(actor: Actor, teamId: string, ref?: string | null, role = "default") {
    const slug = slugify(ref?.trim() || "default");
    const existing = await this.repo.findRepository(teamId, { slug });
    if (existing) return existing;
    const r = await this.repo.insertRepository({ teamId, workspaceId: actor.workspaceId, displayName: ref?.trim() || "Default", role, provider: "local", slug, lifecycle: "live", lastEventAt: new Date() });
    await this.events.emit(actor, teamId, { type: "repository.created", entity: "team", entityId: r.id, summary: `registered repository "${r.displayName}" from a client report` });
    await this.systemNode(actor, teamId, r);
    return r;
  }

  // ───────── the web app's bodies ─────────

  private fields(b: Body, creating: boolean): Partial<RepositoryInput> {
    const displayName = text(b, "displayName", { required: creating, max: 200 });
    const role = text(b, "role", { required: creating, max: 100 });
    if (displayName !== undefined && !displayName.trim()) bad("displayName", "displayName is required");
    if (role !== undefined && !role.trim()) bad("role", "role is required");
    const out: Partial<RepositoryInput> = {
      displayName,
      role,
      provider: oneOf(b, "provider", schema.REPO_PROVIDERS),
      defaultBranch: text(b, "defaultBranch", { max: 200 }),
      pathLimit: textOrNull(b, "pathLimit"),
      lifecycle: oneOf(b, "lifecycle", schema.REPO_LIFECYCLES),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  }

  createRepositoryAs(actor: Actor, teamKey: string, b: Body) {
    return this.createRepository(actor, teamKey, this.fields(b, true) as RepositoryInput);
  }

  updateRepositoryAs(actor: Actor, teamKey: string, id: string, b: Body) {
    return this.updateRepository(actor, teamKey, id, this.fields(b, false));
  }

  /**
   * The file paths of a connected GitHub repository's default branch, for the doc anchor picker. Read-only. The repository is looked up
   * in the person's own team, so an id from another workspace's team never matches and is "not found", never another workspace's tree.
   */
  async browseRepoTreeAs(actor: Actor, teamKey: string, id: string) {
    const repo = (await this.listRepositories(actor, teamKey)).find((r) => r.id === id);
    if (!repo) throw new ServiceError("not_found", `Repository "${id}" not found`);
    if (repo.provider !== "github" || !repo.githubInstallationId || !repo.githubRepoId) throw new ServiceError("invalid", "This repository is not connected to GitHub");
    const gh = github();
    if (!gh) throw new ServiceError("invalid", "GitHub is not set up on this server");
    const { files, truncated } = await gh.api.treeAt(repo.githubInstallationId, repo.githubRepoId, repo.defaultBranch || "main");
    return { files: files.map((f) => f.path), truncated };
  }
}
