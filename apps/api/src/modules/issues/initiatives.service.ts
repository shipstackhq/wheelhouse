import { Inject, Injectable } from "@nestjs/common";
import * as schema from "../../db/schema";
import type { InitiativeStatus } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { Database } from "../../platform/database/database";
import { TeamAccessService } from "../teams/index";
import { InitiativesRepository, type InitiativeInsert, type InitiativeRow } from "./initiatives.repository";
import { ProjectsService } from "./projects.service";
import { bad, checkParent, day, depthOf, healthOf, initiativeHealth, oneOf, positionBetween, reachableProjects, sumProgress, text, treeOf, type HealthView, type InitiativeInput, type ProgressCounts, type Tree } from "./issues.rules";

/**
 * Initiatives (WH-119): a goal that groups projects and other initiatives, up to three levels deep. It belongs to the workspace and
 * every member except a guest sees it. Its progress is rolled up from the issues of the projects linked to it and to the
 * initiatives under it, an issue once however many links reach it. What an initiative shows of a project follows the project's own
 * rule (ADR-23): a project of one of the viewer's teams is shown in full, any other only adds to the counts and the totals, with no
 * name and no issue. No initiative page ever lists an issue.
 */

export type { InitiativeRow };

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

type Who = { role: schema.WorkspaceRole; isAdmin: boolean };
type Linked = Map<string, string[]>; // initiative → its linked projects
type Context = { tree: Tree<InitiativeRow>; linked: Linked; progress: Map<string, ProgressCounts>; owners: Map<string, string>; who: Who };

export type InitiativeSummary = {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  status: InitiativeStatus;
  health: HealthView;
  targetDate: string | null;
  owner: { id: string; name: string } | null;
  /** Rolled up from the issues of every project below, each issue once. */
  total: number;
  done: number;
  /** Projects linked to this initiative itself, and how many initiatives sit directly under it. */
  projectCount: number;
  childCount: number;
  /** 1 for a top initiative. */
  depth: number;
  version: number;
  canEdit: boolean;
  updatedAt: Date;
};

export type InitiativeProjectView = { id: string; name: string; status: schema.ProjectStatus; health: HealthView; targetDate: string | null; total: number; done: number; direct: boolean };
export type InitiativeDetail = InitiativeSummary & {
  /** From the top initiative down to the parent. */
  path: { id: string; name: string }[];
  children: InitiativeSummary[];
  /** Projects of the viewer's teams that the initiative reaches. `direct`: linked here, not only through a sub-initiative. */
  projects: InitiativeProjectView[];
  /** The rest of the projects it reaches: how many, and their issue totals. Never a name. */
  hidden: { count: number; total: number; done: number };
  /** Projects the viewer sees that are not linked here yet, if they can edit. */
  linkable: { id: string; name: string }[];
};

function humanOnly(actor: Actor) {
  if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", "Only teammates work with initiatives");
}

const mayCreate = (w: Who) => w.role !== "viewer";
const mayEdit = (w: Who, actor: Actor, i: Pick<InitiativeRow, "ownerId">) => w.isAdmin || (w.role !== "viewer" && i.ownerId === actor.id);

function parentOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (!isUuid(v)) return bad("parentId", "parentId must be an initiative id, or null for a top one");
  return v;
}

function indexOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return bad("index", "index must be a position from 0");
  return v;
}

@Injectable()
export class InitiativesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(InitiativesRepository) private readonly repo: InitiativesRepository,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
  ) {}

  // ───────── who may do what ─────────

  /** Everyone but a guest can read; the workspace's owners and admins can also edit any initiative, others only their own. */
  private async whoIs(actor: Actor): Promise<Who> {
    humanOnly(actor);
    const role = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!role || role === "guest") throw new ServiceError("not_found", "Initiative not found");
    return { role, isAdmin: role === "owner" || role === "admin" };
  }

  // ───────── roll-up ─────────

  private async linksOf(ids: string[]): Promise<Linked> {
    const out: Linked = new Map(ids.map((i) => [i, []]));
    if (!ids.length) return out;
    for (const r of await this.repo.linksOf(ids)) out.get(r.initiativeId)!.push(r.projectId);
    return out;
  }

  private async context(actor: Actor, who: Who): Promise<Context> {
    const rows = await this.repo.liveOf(actor.workspaceId);
    const tree = treeOf(rows);
    const linked = await this.linksOf(rows.map((r) => r.id));
    const progress = await this.projects.progressOf([...new Set([...linked.values()].flat())]);
    const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => !!x))];
    const owners = new Map((ownerIds.length ? await this.repo.namesOfUsers(ownerIds) : []).map((u) => [u.id, u.name]));
    return { tree, linked, progress, owners, who };
  }

  private summarise(c: Context, actor: Actor, i: InitiativeRow, now: Date): InitiativeSummary {
    const pr = sumProgress(reachableProjects(c.tree, c.linked, i.id), c.progress);
    return {
      id: i.id,
      parentId: i.parentId && c.tree.byId.has(i.parentId) ? i.parentId : null,
      name: i.name,
      description: i.description,
      status: i.status,
      health: initiativeHealth(i, pr, now),
      targetDate: i.targetDate,
      owner: i.ownerId && c.owners.has(i.ownerId) ? { id: i.ownerId, name: c.owners.get(i.ownerId)! } : null,
      total: pr.total,
      done: pr.done,
      projectCount: c.linked.get(i.id)?.length ?? 0,
      childCount: c.tree.kids.get(i.id)?.length ?? 0,
      depth: depthOf(c.tree, i.id),
      version: i.version,
      canEdit: mayEdit(c.who, actor, i),
      updatedAt: i.updatedAt,
    };
  }

  // ───────── reading ─────────

  /** Every initiative of the workspace as a flat list in tree order (a parent before its children), for the list page to indent. A guest sees none. */
  async listInitiatives(actor: Actor, now = new Date()): Promise<InitiativeSummary[]> {
    humanOnly(actor);
    const role = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!role || role === "guest") return [];
    const c = await this.context(actor, { role, isAdmin: role === "owner" || role === "admin" });
    const out: InitiativeSummary[] = [];
    const walk = (parent: string | null) => {
      for (const i of c.tree.kids.get(parent) ?? []) {
        out.push(this.summarise(c, actor, i, now));
        walk(i.id);
      }
    };
    walk(null);
    return out;
  }

  async getInitiative(actor: Actor, id: string, now = new Date()): Promise<InitiativeDetail> {
    const who = await this.whoIs(actor);
    const c = await this.context(actor, who);
    const row = isUuid(id) ? c.tree.byId.get(id) : undefined;
    if (!row) throw new ServiceError("not_found", "Initiative not found");
    const summary = this.summarise(c, actor, row, now);
    const path: { id: string; name: string }[] = [];
    for (let p = row.parentId ? c.tree.byId.get(row.parentId) : undefined; p; p = p.parentId ? c.tree.byId.get(p.parentId) : undefined) path.unshift({ id: p.id, name: p.name });
    const reach = reachableProjects(c.tree, c.linked, id);
    const direct = new Set(c.linked.get(id) ?? []);
    const seen = new Set(await this.projects.visibleProjectIds(actor.id));
    const mineIds = reach.filter((p) => seen.has(p));
    const pRows = mineIds.length ? await this.projects.projectsByIds(mineIds) : [];
    const projectViews: InitiativeProjectView[] = pRows
      .map((p) => {
        const pr = c.progress.get(p.id) ?? { total: 0, done: 0 };
        return { id: p.id, name: p.name, status: p.status, health: healthOf(p, pr, now), targetDate: p.targetDate, total: pr.total, done: pr.done, direct: direct.has(p.id) };
      })
      .sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
    const hiddenIds = reach.filter((p) => !seen.has(p));
    const hidden = { count: hiddenIds.length, ...sumProgress(hiddenIds, c.progress) };
    let linkable: { id: string; name: string }[] = [];
    if (summary.canEdit) {
      const mine = await this.projects.visibleProjectNames(actor);
      linkable = mine.filter((p) => !direct.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
    }
    return {
      ...summary,
      path,
      children: (c.tree.kids.get(id) ?? []).map((k) => this.summarise(c, actor, k, now)),
      projects: projectViews,
      hidden,
      linkable,
    };
  }

  // ───────── writing ─────────

  private async ownerMember(actor: Actor, v: unknown): Promise<string | null | undefined> {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    if (!isUuid(v)) return bad("owner", "owner must be a person's id");
    const role = await this.access.workspaceRoleOf(actor.workspaceId, v);
    if (!role || role === "guest") return bad("owner", "The owner must be a member of the workspace (not a guest)");
    return v;
  }

  /** The initiative as it is now under a row lock; a deleted one is not found, and a version the caller read that is stale is a 409. */
  private async lockInitiative(id: string, expected?: unknown) {
    const row = await this.repo.lock(id);
    if (!row || row.deletedAt) throw new ServiceError("not_found", "Initiative not found");
    if (typeof expected === "number" && expected !== row.version) throw new ServiceError("conflict", `The initiative was changed (version ${row.version}, you had ${expected}). Re-read and retry.`, { current: row });
    return row;
  }

  async createInitiative(actor: Actor, input: InitiativeInput, now = new Date()): Promise<InitiativeDetail> {
    const who = await this.whoIs(actor);
    if (!mayCreate(who)) throw new ServiceError("forbidden", "Viewers cannot create initiatives");
    const name = text(input.name, "name", 120, true)!;
    const description = text(input.description, "description", 20_000) ?? "";
    const status = oneOf(input.status, schema.INITIATIVE_STATUSES, "status") ?? "planned";
    const targetDate = day(input.targetDate, "targetDate") ?? null;
    const healthOverride = oneOf(input.healthOverride, schema.PROJECT_HEALTH, "healthOverride") ?? null;
    const owner = (await this.ownerMember(actor, input.owner)) ?? actor.id;
    const parentId = parentOf(input.parentId) ?? null;
    const created = await this.db.transaction(async () => {
      await this.repo.lockTree(actor.workspaceId);
      const t = treeOf(await this.repo.liveOf(actor.workspaceId));
      checkParent(t, null, parentId);
      const parent = parentId ? t.byId.get(parentId)! : null;
      if (parent && !mayEdit(who, actor, parent)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can add one under it");
      const sibs = t.kids.get(parentId) ?? [];
      const position = (sibs.at(-1)?.position ?? 0) + 1000;
      const i = await this.repo.insert({ workspaceId: actor.workspaceId, parentId, name, description, ownerId: owner, status, targetDate, healthOverride, position });
      await this.projects.workspaceEvent(actor, { entity: "initiative", type: "initiative.created", entityId: i.id, summary: `created initiative "${i.name}"${parent ? ` under "${parent.name}"` : ""}`, data: { parentId, status } });
      return i;
    });
    return this.getInitiative(actor, created.id, now);
  }

  async updateInitiative(actor: Actor, id: string, patch: InitiativeInput, now = new Date()): Promise<InitiativeDetail> {
    const who = await this.whoIs(actor);
    const name = text(patch.name, "name", 120, patch.name !== undefined);
    const description = text(patch.description, "description", 20_000);
    const status = oneOf(patch.status, schema.INITIATIVE_STATUSES, "status");
    const targetDate = day(patch.targetDate, "targetDate");
    const healthOverride = patch.healthOverride === null ? null : oneOf(patch.healthOverride, schema.PROJECT_HEALTH, "healthOverride");
    const owner = await this.ownerMember(actor, patch.owner);
    const parentId = parentOf(patch.parentId);
    const index = indexOf(patch.index);
    await this.db.transaction(async () => {
      await this.repo.lockTree(actor.workspaceId);
      const cur = await this.lockInitiative(isUuid(id) ? id : NIL_UUID, patch.version);
      if (cur.workspaceId !== actor.workspaceId) throw new ServiceError("not_found", "Initiative not found");
      if (!mayEdit(who, actor, cur)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can change it");
      const t = treeOf(await this.repo.liveOf(actor.workspaceId));
      const set: Partial<InitiativeInsert> = {};
      if (name !== undefined && name !== cur.name) set.name = name;
      if (description !== undefined && description !== cur.description) set.description = description;
      if (status !== undefined && status !== cur.status) set.status = status;
      if (targetDate !== undefined && targetDate !== cur.targetDate) set.targetDate = targetDate;
      if (healthOverride !== undefined && healthOverride !== cur.healthOverride) set.healthOverride = healthOverride;
      if (owner !== undefined && owner !== cur.ownerId) set.ownerId = owner;
      const moves = parentId !== undefined && parentId !== cur.parentId;
      if (moves) {
        checkParent(t, id, parentId!);
        const to = parentId ? t.byId.get(parentId)! : null;
        if (to && !mayEdit(who, actor, to)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can move one under it");
        set.parentId = parentId!;
      }
      if (moves || index !== undefined) {
        const dest = moves ? parentId! : cur.parentId;
        const sibs = (t.kids.get(dest) ?? []).filter((s) => s.id !== id);
        const position = index !== undefined ? this.positionAt(sibs, Math.min(index, sibs.length)) : (sibs.at(-1)?.position ?? 0) + 1000;
        if (position !== cur.position) set.position = position;
      }
      if (!Object.keys(set).length) return;
      const u = await this.repo.update(id, { ...set, version: cur.version + 1, updatedAt: new Date() });
      const changed = Object.keys(set);
      await this.projects.workspaceEvent(actor, {
        entity: "initiative",
        type: "initiative.updated",
        entityId: id,
        summary: `updated initiative "${u.name}": ${changed.join(", ")}`,
        data: { changed, from: Object.fromEntries(changed.map((k) => [k, (cur as Record<string, unknown>)[k]])), to: Object.fromEntries(changed.map((k) => [k, (u as Record<string, unknown>)[k]])) },
      });
    });
    return this.getInitiative(actor, id, now);
  }

  /** The position that puts an initiative at `index` among its siblings (without itself). */
  private positionAt(siblings: InitiativeRow[], index: number): number {
    return positionBetween(siblings[index - 1]?.position, siblings[index]?.position);
  }

  /**
   * Delete an initiative (soft). The initiatives under it move up to its parent, so nothing goes past the depth limit and nothing is
   * lost; its links to projects go, and the projects themselves are left as they are.
   */
  async deleteInitiative(actor: Actor, id: string) {
    const who = await this.whoIs(actor);
    return this.db.transaction(async () => {
      await this.repo.lockTree(actor.workspaceId);
      const cur = await this.lockInitiative(isUuid(id) ? id : NIL_UUID);
      if (cur.workspaceId !== actor.workspaceId) throw new ServiceError("not_found", "Initiative not found");
      if (!mayEdit(who, actor, cur)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can delete it");
      const t = treeOf(await this.repo.liveOf(actor.workspaceId));
      const kids = t.kids.get(id) ?? [];
      const siblings = (t.kids.get(cur.parentId) ?? []).filter((s) => s.id !== id);
      let position = (siblings.at(-1)?.position ?? 0) + 1000;
      for (const k of kids) {
        await this.repo.update(k.id, { parentId: cur.parentId, position, version: k.version + 1, updatedAt: new Date() });
        position += 1000;
      }
      const links = await this.repo.deleteLinks(id);
      await this.repo.update(id, { deletedAt: new Date(), version: cur.version + 1, updatedAt: new Date() });
      await this.projects.workspaceEvent(actor, {
        entity: "initiative",
        type: "initiative.deleted",
        entityId: id,
        summary: `deleted initiative "${cur.name}"${kids.length ? ` (${kids.length} below it moved up)` : ""}`,
        data: { name: cur.name, moved: kids.length, unlinked: links.length },
      });
      return { ok: true, moved: kids.length, unlinked: links.length };
    });
  }

  // ───────── linked projects ─────────

  private async editable(actor: Actor, id: string) {
    const who = await this.whoIs(actor);
    const row = isUuid(id) ? await this.repo.findLive(actor.workspaceId, id) : undefined;
    if (!row) throw new ServiceError("not_found", "Initiative not found");
    if (!mayEdit(who, actor, row)) throw new ServiceError("forbidden", "Only the owner of an initiative, or a workspace admin, can change what it groups");
    return row;
  }

  /** Link a project. The person must see it (a project of one of their teams); one they cannot see answers not found. */
  async linkProject(actor: Actor, id: string, projectId: unknown, now = new Date()) {
    await this.editable(actor, id);
    if (!isUuid(projectId)) bad("projectId", "projectId must be a project id");
    const { project } = await this.projects.openProject(actor, projectId as string, "read");
    await this.db.transaction(async () => {
      const cur = await this.lockInitiative(id);
      if (await this.repo.hasLink(id, project.id)) throw new ServiceError("conflict", `"${project.name}" is already in this initiative`);
      await this.repo.insertLink({ initiativeId: id, projectId: project.id, workspaceId: actor.workspaceId });
      await this.repo.update(id, { version: cur.version + 1, updatedAt: new Date() });
      await this.projects.workspaceEvent(actor, { entity: "initiative", type: "initiative.project_linked", entityId: id, summary: `added project "${project.name}" to initiative "${cur.name}"`, data: { projectId: project.id } });
    });
    return this.getInitiative(actor, id, now);
  }

  /** Unlink a project. The project and its issues are untouched. */
  async unlinkProject(actor: Actor, id: string, projectId: string, now = new Date()) {
    await this.editable(actor, id);
    const { project } = await this.projects.openProject(actor, projectId, "read");
    await this.db.transaction(async () => {
      const cur = await this.lockInitiative(id);
      const gone = await this.repo.deleteLinks(id, project.id);
      if (!gone.length) throw new ServiceError("not_found", "That project is not in this initiative");
      await this.repo.update(id, { version: cur.version + 1, updatedAt: new Date() });
      await this.projects.workspaceEvent(actor, { entity: "initiative", type: "initiative.project_unlinked", entityId: id, summary: `removed project "${project.name}" from initiative "${cur.name}"`, data: { projectId: project.id } });
    });
    return this.getInitiative(actor, id, now);
  }
}
