import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { Q } from "../../platform/database/transaction";
import { emit } from "../../platform/events/emit";
import { upsertNode } from "../map/graph";
import { requireTeam } from "../teams/teams";

const { repositories } = schema;

// ───────── repositories (WH-68) ─────────

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

export const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";

/** Map a repository's lifecycle to the map-node status its system node should carry. */
export function statusForLifecycle(lifecycle: (typeof schema.REPO_LIFECYCLES)[number]): (typeof schema.nodes.$inferSelect)["status"] {
  const map = { live: "live", being_replaced: "deprecated", planned: "planned", retired: "deprecated" } satisfies Record<
    (typeof schema.REPO_LIFECYCLES)[number],
    (typeof schema.nodes.$inferSelect)["status"]
  >;
  return map[lifecycle];
}

export async function repoSystemNode(actor: Actor, teamId: string, repo: typeof repositories.$inferSelect) {
  await upsertNode(actor, teamId, {
    name: repo.displayName,
    layer: "system",
    kind: "service",
    summary: `Repository: ${repo.role}`,
    anchors: [`${repo.slug}:**`],
    status: statusForLifecycle(repo.lifecycle),
  });
}

export async function listRepositories(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db.select().from(repositories).where(eq(repositories.teamId, team.id)).orderBy(asc(repositories.createdAt));
}

export async function resolveRepository(q: Q, teamId: string, ref: string) {
  const [r] = await q.select().from(repositories).where(and(eq(repositories.teamId, teamId), isUuid(ref) ? eq(repositories.id, ref) : eq(repositories.slug, ref)));
  if (!r) throw new ServiceError("not_found", `Repository "${ref}" not found`);
  return r;
}

/** Owner-only create/update of a repository's management fields. Owners manage repos; see createIssue for the human/agent split used elsewhere. */
export async function createRepository(actor: Actor, teamRef: string, input: RepositoryInput) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can add repositories");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  if (!input.displayName?.trim()) throw new ServiceError("invalid", "displayName is required");
  if (!input.role?.trim()) throw new ServiceError("invalid", "role is required");
  const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.displayName);
  const [existing] = await db.select().from(repositories).where(and(eq(repositories.teamId, team.id), eq(repositories.slug, slug)));
  if (existing) throw new ServiceError("conflict", `A repository with slug "${slug}" already exists on this team`);
  const [r] = await db
    .insert(repositories)
    .values({
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
    })
    .returning();
  await emit(db, actor, team.id, { type: "repository.created", entity: "team", entityId: r.id, summary: `added repository "${r.displayName}" (${r.role})` });
  await repoSystemNode(actor, team.id, r);
  return r;
}

export async function updateRepository(actor: Actor, teamRef: string, ref: string, patch: Partial<RepositoryInput>) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can edit repositories");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const existing = await resolveRepository(db, team.id, ref);
  const set: Partial<typeof repositories.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName.trim();
  if (patch.role !== undefined) set.role = patch.role.trim();
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.githubRepoId !== undefined) set.githubRepoId = patch.githubRepoId;
  if (patch.githubInstallationId !== undefined) set.githubInstallationId = patch.githubInstallationId;
  if (patch.defaultBranch !== undefined) set.defaultBranch = patch.defaultBranch.trim() || "main";
  if (patch.pathLimit !== undefined) set.pathLimit = patch.pathLimit?.trim() || null;
  if (patch.lifecycle !== undefined) set.lifecycle = patch.lifecycle;
  const [r] = await db.update(repositories).set(set).where(eq(repositories.id, existing.id)).returning();
  await emit(db, actor, team.id, { type: "repository.updated", entity: "team", entityId: r.id, summary: `updated repository "${r.displayName}"` });
  if (patch.lifecycle !== undefined && patch.lifecycle !== existing.lifecycle) await repoSystemNode(actor, team.id, r);
  return r;
}

/** Retire a repository (soft: lifecycle -> retired). Never deletes landed history (team_files rows keep their repositoryId). */
export async function retireRepository(actor: Actor, teamRef: string, ref: string) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can retire repositories");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const existing = await resolveRepository(db, team.id, ref);
  const [r] = await db.update(repositories).set({ lifecycle: "retired", updatedAt: new Date() }).where(eq(repositories.id, existing.id)).returning();
  await emit(db, actor, team.id, { type: "repository.retired", entity: "team", entityId: r.id, summary: `retired repository "${r.displayName}"` });
  await repoSystemNode(actor, team.id, r);
  return r;
}

/**
 * Find-or-create used by the file-reporting path (wheelhouse.json names its repository on report;
 * a repo linked locally before this change registers automatically on its next report). `ref` is the
 * repo slug/name (or github id) the client sends; omitted falls back to a team-default row so old
 * CLI versions / repos without wheelhouse.json repo info keep reporting unqualified, as before.
 */
export async function findOrCreateRepository(actor: Actor, teamId: string, ref?: string | null, role = "default") {
  const db = await getDb();
  const slug = slugify(ref?.trim() || "default");
  const [existing] = await db.select().from(repositories).where(and(eq(repositories.teamId, teamId), eq(repositories.slug, slug)));
  if (existing) return existing;
  const [r] = await db
    .insert(repositories)
    .values({ teamId, workspaceId: actor.workspaceId, displayName: ref?.trim() || "Default", role, provider: "local", slug, lifecycle: "live", lastEventAt: new Date() })
    .returning();
  await emit(db, actor, teamId, { type: "repository.created", entity: "team", entityId: r.id, summary: `registered repository "${r.displayName}" from a client report` });
  await repoSystemNode(actor, teamId, r);
  return r;
}
