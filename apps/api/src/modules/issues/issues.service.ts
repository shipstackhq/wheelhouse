import { Inject, Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { statusForRole, roleFromText } from "@wheelhouse/shared/status-roles";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { cleanLabels } from "../../common/labels";
import { assertWritable, roleAllows, type Need } from "../../common/roles";
import { isUuid } from "../../common/uuid";
import { Database } from "../../platform/database/database";
import { diff } from "../../platform/events/emit";
import { EventsService } from "../../platform/events/events.service";
import { DeliveriesService } from "../github/index";
import { ActorsService } from "../actors/index";
import { effectiveProfile } from "../agents/index";
import { GraphService, SessionsService } from "../map/index";
import { TeamAccessService } from "../teams/index";
import { CyclesService, systemActor } from "./cycles/cycles.service";
import { ISSUE_COMMENTED, ISSUE_DELEGATED, type IssueCommented, type IssueDelegated } from "./issues.events";
import { IssueTargets } from "./issue-targets";
import { IssueNotifications } from "./issues.notifications";
import { IssuesRepository, type CommentRow, type IssueRow, type TeamRow } from "./issues.repository";
import { CLAIM_TTL_MS, DEFAULT_STATUSES, MAX_ISSUE_DEPTH, delegationState, fitsDepth, suggestAgent, parseIssueRef, positionAmong, sameLabels, type Delegation, type IssueInput } from "./issues.rules";
import { issueView } from "./issues.presenter";
import { ProjectsService } from "./projects/projects.service";

export type IssueWithLinks = IssueRow & { ref: string; labels: string[]; cycle: number | null; nodeIds: string[]; commentCount: number; delegation: Delegation | null };
export type IssueRelative = { ref: string; title: string; priority: IssueRow["priority"]; status: string; done: boolean; canceled: boolean; assigneeId: string | null };

/**
 * Issues: create, change (with optimistic locking), move, delete, claim, comment, link to the map, the board, and sub-issues. An issue
 * is reached only through its team (`TeamAccessService.require`, or `resolveIssue`, which also answers for the issue's ref), and every
 * change writes its event on the same transaction. Cycles, projects and the labels of an issue are looked up through their own services.
 *
 * Sub-issues: an issue can sit under another issue of its own team, as deep as MAX_ISSUE_DEPTH levels. The one thing that must never
 * happen is a loop (an issue under its own descendant), and it is refused here, not by the database: a loop has no single row to
 * check, only the chain above the new parent. The check is one recursive query up the parent chain, which is as many primary-key
 * lookups as the chain is long. A closure table would make it constant, but every re-parent would then rewrite the moved issue's whole
 * subtree, and that is the common edit. Two people moving A under B and B under A at the same moment would each pass the check, so a
 * re-parent takes the team's row lock first, as cycles do, and the second one checks against the first one's result.
 *
 * Inbox items (assigned, commented, ready for review) are sent by `IssueNotifications` after the change commits, never inside its transaction.
 */
@Injectable()
export class IssuesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(IssuesRepository) private readonly repo: IssuesRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(CyclesService) private readonly cycles: CyclesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(DeliveriesService) private readonly deliveries: DeliveriesService,
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(IssueNotifications) private readonly notices: IssueNotifications,
    @Inject(IssueTargets) private readonly targets: IssueTargets,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
    @Inject(ActorsService) private readonly actors: ActorsService,
  ) {}

  // ───────── the board ─────────

  /**
   * Release agent claims with no activity from the claiming agent for a day, so a
   * crashed or abandoned session doesn't hold work hostage. Logged as an event.
   */
  async expireStaleClaims(team: { id: string; key: string; workspaceId: string }) {
    for (const t of await this.repo.claimedIssues(team.id)) {
      const lastAt = new Date((await this.repo.lastEventAt(t.id, t.claimedByKeyId!)) ?? t.updatedAt).getTime();
      if (Date.now() - lastAt < CLAIM_TTL_MS) continue;
      await this.db.transaction(async () => {
        await this.repo.releaseClaim(t.id, t.version + 1);
        await this.events.emit(systemActor(team.workspaceId, team.id), team.id, {
          type: "issue.claim_expired",
          entity: "issue",
          entityId: t.id,
          summary: `released ${team.key}-${t.number}: no activity from the claiming agent for 24h`,
          data: { ref: `${team.key}-${t.number}` },
        });
      });
    }
  }

  async getBoard(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    await this.expireStaleClaims(team);
    await this.cycles.rolloverCycles(team.id);
    const cols = await this.repo.statusesOf(team.id);
    const ts = await this.repo.issuesOf(team.id);
    const ids = ts.map((t) => t.id);
    const links = ids.length ? await this.repo.nodeLinksOf(ids) : [];
    const labelMap = await this.labelsOf(ids);
    const cycleOf = new Map((await this.cycles.withCycle(ts)).map((t) => [t.id, t.cycle]));
    const counts = ids.length ? await this.repo.commentCounts(ids) : [];
    const countMap = new Map(counts.map((c) => [c.issueId, Number(c.n)]));
    const delegations = await this.delegationsOf(ts);
    const withLinks: IssueWithLinks[] = ts.map((t) => ({
      ...t,
      ref: `${team.key}-${t.number}`,
      labels: labelMap.get(t.id) ?? [],
      cycle: cycleOf.get(t.id) ?? null,
      nodeIds: links.filter((l) => l.issueId === t.id).map((l) => l.nodeId),
      commentCount: countMap.get(t.id) ?? 0,
      delegation: delegations.get(t.id) ?? null,
    }));
    return { team, statuses: cols, issues: withLinks };
  }

  /** WH-132, WH-134: where each delegated issue among `rows` stands: its state, what the running agent last did, and the pull requests of its runs. */
  private async delegationsOf(rows: { id: string; delegateAgentId: string | null }[]): Promise<Map<string, Delegation>> {
    const delegated = rows.filter((r) => r.delegateAgentId);
    const out = new Map<string, Delegation>();
    if (!delegated.length) return out;
    const runs = await this.repo.delegationRuns(delegated.map((r) => r.id));
    const lines = await this.repo.lastLines(runs.filter((x) => ["offered", "accepted", "running"].includes(x.state)).map((x) => x.id));
    for (const r of delegated) {
      const mine = runs.filter((x) => x.issueId === r.id);
      const state = delegationState((await this.targets.of(r.id)).targets.length > 0, mine.map((x) => ({ ...x, asked: !!x.result?.question })));
      const active = mine.find((x) => lines.has(x.id));
      const prs = mine.flatMap((x) => (x.result?.pullRequest ? [{ ...(x.result.pullRequest as { number: number; url: string }), state: x.prState }] : []));
      out.set(r.id, { state, line: state === "running" && active ? lines.get(active.id)! : null, prs: [...new Map(prs.map((p) => [p.number, p])).values()] });
    }
    return out;
  }

  /** The team page's parts: the board, the map nodes an issue can link to, the team's members (the people an issue can be assigned to), and its cycles and projects. */
  async boardPage(actor: Actor, teamKey: string) {
    const board = await this.getBoard(actor, teamKey);
    const [nodes, people] = await Promise.all([this.repo.boardNodes(board.team.id), this.repo.teamMembersOf(board.team.id)]);
    const faces = await this.actors.resolve(actor.workspaceId, people.map((p) => ({ kind: "human" as const, id: p.id, name: p.name })));
    const members = people.map((p, i) => ({ id: p.id, name: p.name, kind: "human" as const, avatar: faces[i].avatar }));
    const cycles = await this.cycles.cycleOptions(board.team.id);
    const projects = await this.projects.projectsOfTeam(board.team.id);
    return { board, nodes, members, cycles, projects };
  }

  // ───────── finding an issue ─────────

  /** An assignee must be a member of the issue's team: a user from another workspace, a workspace member who is not on the team, or a made-up id is refused. */
  async assertAssignee(teamId: string, userId: string | null | undefined) {
    if (!userId) return;
    const member = isUuid(userId) ? await this.repo.isTeamMember(teamId, userId) : false;
    if (!member) throw new ServiceError("invalid", "Assignee must be a member of this team");
  }

  async resolveStatus(teamId: string, ref: string) {
    const cols = await this.repo.statusesOf(teamId);
    // An id or an exact name wins; otherwise a role ("review") finds the status with that role even if it was renamed.
    const role = roleFromText(ref);
    const c = cols.find((c) => c.id === ref) ?? cols.find((c) => c.name.toLowerCase() === ref.toLowerCase()) ?? (role ? statusForRole(cols, role) : undefined);
    if (!c) throw new ServiceError("invalid", `Unknown status "${ref}". Valid: ${cols.map((c) => c.name).join(", ")}`);
    return c;
  }

  /** Accepts an issue uuid or a ref like "WH-12". An issue of a team the actor cannot open is not_found; `need` says what the caller will do with it. */
  async resolveIssue(actor: Actor, ref: string, need: Need = "read") {
    let row: { t: IssueRow; p: TeamRow } | undefined;
    if (isUuid(ref)) {
      row = await this.repo.findWithTeam(actor.workspaceId, { id: ref });
    } else {
      const m = parseIssueRef(ref);
      if (!m) throw new ServiceError("invalid", `Bad issue ref "${ref}" (use uuid or KEY-123)`);
      row = await this.repo.findWithTeam(actor.workspaceId, { teamKey: m.key.toUpperCase(), number: m.number });
    }
    const role = row ? await this.access.roleOn(actor, row.p.id) : null;
    if (!row || !role) throw new ServiceError("not_found", `Issue ${ref} not found`);
    if (!roleAllows(role, need)) throw new ServiceError("forbidden", "Your role on this team is read only");
    if (need === "edit") assertWritable(row.p);
    return { issue: row.t, team: row.p, ref: `${row.p.key}-${row.t.number}` };
  }

  async getIssue(actor: Actor, ref: string) {
    const { issue, team, ref: r } = await this.resolveIssue(actor, ref);
    const col = await this.repo.statusById(issue.statusId);
    const commentRows = await this.repo.commentsOf(issue.id);
    const authors = await this.actors.resolve(actor.workspaceId, commentRows.map((c) => ({ kind: c.authorKind, id: c.authorId, agentId: c.authorAgentId, name: c.authorName })));
    const comments = commentRows.map((c, i) => ({ ...c, author: authors[i] }));
    const nodes = await this.repo.linkedNodes(issue.id);
    const history = await this.repo.historyOf(team.id, issue.id);
    // Pull requests GitHub reported against this issue (WH-20).
    const pullRequests = await this.deliveries.pullRequestsForIssue(issue.id);
    const [withLabel] = await this.decorate([issue]);
    const { parent, children } = await this.relatives(team, issue);
    const delegation = (await this.delegationsOf([issue])).get(issue.id) ?? null;
    const suggestedAgent = issue.delegateAgentId ? null : await this.suggestedAgent(issue, withLabel.labels);
    return { issue: { ...withLabel, ref: r, status: col?.name, delegation }, suggestedAgent, team, comments, nodes, history, pullRequests, parent, children, ...(await this.targetsWithProposals(issue)) };
  }

  /** WH-125: the roster agent that fits the issue's labels and linked map nodes (a suggestion; a person still picks). */
  private async suggestedAgent(issue: IssueRow, labels: string[]) {
    const roster = (await this.repo.rosterAgents(issue.teamId)).map((a) => {
      const p = effectiveProfile(a);
      return { slug: a.slug, name: p.name, role: p.role, pathScope: p.pathScope };
    });
    return roster.length ? suggestAgent(roster, labels, await this.repo.linkedAnchors(issue.id)) : null;
  }

  /** The issue's targets, and when it has none, where the work probably happens (WH-135) for the person to confirm. */
  private async targetsWithProposals(issue: IssueRow) {
    const settled = await this.targets.of(issue.id);
    return { ...settled, proposedTargets: settled.targets.length ? [] : await this.targets.proposals(issue) };
  }

  /** An issue's parent and its direct sub-issues (in number order), each with the name and kind of its status, so progress can be shown. */
  private async relatives(team: { key: string }, issue: { id: string; parentId: string | null }) {
    const view = (r: { number: number; title: string; priority: IssueRow["priority"]; assigneeId: string | null; status: string; role: string | null }): IssueRelative => ({
      ref: `${team.key}-${r.number}`,
      title: r.title,
      priority: r.priority,
      status: r.status,
      done: r.role === "done",
      canceled: r.role === "canceled",
      assigneeId: r.assigneeId,
    });
    const parent = issue.parentId ? await this.repo.withStatus(issue.parentId) : undefined;
    const children = await this.repo.subIssuesWithStatus(issue.id);
    return { parent: parent ? view(parent) : null, children: children.map(view) };
  }

  // ───────── labels and cycles on issues ─────────

  /** The label names on each issue, alphabetical. */
  private async labelsOf(issueIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>(issueIds.map((id) => [id, []]));
    if (!issueIds.length) return out;
    for (const r of await this.repo.labelRows(issueIds)) out.get(r.issueId)!.push(r.name);
    return out;
  }

  /** Rows of issues with their label names and the number of the cycle they are in. */
  private async decorate<T extends { id: string; cycleId: string | null }>(rows: T[]) {
    const map = await this.labelsOf(rows.map((r) => r.id));
    return this.cycles.withCycle(rows.map((r) => ({ ...r, labels: map.get(r.id) ?? [] })));
  }

  // ───────── sub-issues ─────────

  /**
   * The id of the issue to put `childId` under, from a ref ("WH-12") or an id, or null for none. `childId` is null for an issue that
   * does not exist yet. Throws when the parent is not in the team, would make a loop, or would nest too deep.
   */
  private async resolveParent(team: { id: string; key: string }, childId: string | null, parentRef: string | null): Promise<string | null> {
    if (parentRef === null) return null;
    let parent: { id: string; number: number } | undefined;
    if (isUuid(parentRef)) {
      parent = await this.repo.parentById(team.id, parentRef);
    } else {
      const m = parseIssueRef(parentRef);
      if (!m) throw new ServiceError("invalid", `Bad parent "${parentRef}" (use an issue ref like ${team.key}-12)`);
      if (m.key.toUpperCase() !== team.key.toUpperCase()) throw new ServiceError("invalid", `A sub-issue is in the same team as its parent: ${parentRef} is not in ${team.key}`);
      parent = await this.repo.parentByNumber(team.id, m.number);
    }
    if (!parent) throw new ServiceError("invalid", `Parent issue ${parentRef} not found in ${team.key}`);

    if (childId) {
      // Loops come from re-parenting an issue that already exists; look at the chain only once nobody else is moving issues in this team.
      await this.repo.lockTeam(team.id);
      if (await this.repo.isSelfOrAncestor(childId, parent.id, MAX_ISSUE_DEPTH)) {
        throw new ServiceError("invalid", `${team.key}-${parent.number} cannot be the parent: it is that issue or one of its sub-issues`);
      }
    }
    const above = await this.repo.depthAbove(parent.id, MAX_ISSUE_DEPTH);
    const below = childId ? await this.repo.heightBelow(childId, MAX_ISSUE_DEPTH) : 1;
    if (!fitsDepth(above, below)) throw new ServiceError("invalid", `Sub-issues can be nested at most ${MAX_ISSUE_DEPTH} levels deep`);
    return parent.id;
  }

  // ───────── changing issues ─────────

  /**
   * WH-113: who may delegate and to whom. A person only (an agent never hands work to an agent), and only the issue's assignee or an admin
   * of the team or workspace. The agent must be on the team's roster. Returns the workspace agent id, or null to clear.
   */
  private async resolveDelegate(actor: Actor, team: { id: string }, issue: { id: string; assigneeId: string | null }, slug: string | null): Promise<string | null> {
    if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", "Only a person can delegate an issue to an agent");
    if (actor.id !== issue.assigneeId) {
      const [teamRole, workspaceRole] = await Promise.all([this.access.roleOn(actor, team.id), this.access.workspaceRoleOf(actor.workspaceId, actor.id)]);
      if (teamRole !== "admin" && workspaceRole !== "owner" && workspaceRole !== "admin") {
        throw new ServiceError("forbidden", "Only the assignee or an admin can delegate this issue", { fields: { delegate: "Only the assignee or an admin can delegate this issue" } });
      }
    }
    if (slug === null) return null;
    // A parent's run owns its sub-issues (WH-137): one at a time would work on the same thing twice.
    if (await this.repo.parentRunActive(issue.id)) throw new ServiceError("conflict", "Its parent's run is active and owns this issue", { fields: { delegate: "Its parent's run is active and owns this issue" } });
    const id = await this.repo.rosterAgentId(team.id, slug);
    if (!id) throw new ServiceError("invalid", `${slug} is not on this team's roster`, { fields: { delegate: `${slug} is not on this team's roster` } });
    return id;
  }

  /** WH-137: the open sub-issues of an issue, in order, as the brief of a run that takes the whole set. */
  async openSubIssues(team: { key: string }, issueId: string) {
    return (await this.repo.openSubIssues(issueId)).map((r) => ({ ref: `${team.key}-${r.number}`, title: r.title, body: r.body }));
  }

  /** The workspace agent with this slug on the team's roster, or undefined. */
  rosterAgentId(teamId: string, slug: string) {
    return this.repo.rosterAgentId(teamId, slug);
  }

  /**
   * WH-127: run the issue's delegate again, with the actor as the requester (the assignee taking over a run an admin started, or a rerun
   * after a failure). Same permission as delegating. The active run is stopped and a new one started by the delegation listener.
   */
  async rerunDelegate(actor: Actor, ref: string) {
    const out = await this.db.transaction(async () => {
      const { issue, team, ref: r } = await this.resolveIssue(actor, ref, "edit");
      if (!issue.delegateAgentId) throw new ServiceError("invalid", `${r} is not delegated to an agent`);
      await this.resolveDelegate(actor, team, issue, null);
      await this.repo.updateIssue(issue.id, { delegatedBy: actor.id, delegatedAt: new Date(), updatedAt: new Date() });
      return { id: issue.id, ref: r, agentId: issue.delegateAgentId };
    });
    await this.emitter.emitAsync(ISSUE_DELEGATED, { actor, issueId: out.id, ref: out.ref, agentId: out.agentId } satisfies IssueDelegated);
    return { ok: true };
  }

  private async positionAt(statusId: string, index: number | undefined, excludeId?: string) {
    return positionAmong(await this.repo.siblingsInStatus(statusId, excludeId), index);
  }

  async createIssue(actor: Actor, teamRef: string, input: IssueInput & { title: string; status?: string }) {
    const team = await this.access.require(actor, teamRef, "edit");
    if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
    const made = await this.db.transaction(async () => {
      await this.assertAssignee(team.id, input.assigneeId);
      const cycle = input.cycle == null ? null : await this.cycles.cycleForIssue(team.id, input.cycle);
      const inProject =
        input.projectId === undefined && input.milestoneId === undefined
          ? { projectId: null, milestoneId: null }
          : await this.projects.resolveIssueProject(team, { projectId: null, milestoneId: null }, { project: input.projectId, milestone: input.milestoneId });
      const parentId = input.parent == null ? null : await this.resolveParent(team, null, input.parent);
      const targets = input.targets?.length ? await this.targets.resolve({ teamId: team.id, projectId: inProject.projectId }, input.targets) : [];
      const col = await this.resolveStatus(team.id, input.status ?? DEFAULT_STATUSES[0]);
      const number = await this.repo.nextNumber(team.id);
      const position = await this.positionAt(col.id, undefined);
      const t = await this.repo.insertIssue({
        teamId: team.id,
        workspaceId: team.workspaceId,
        statusId: col.id,
        number,
        title: input.title.trim(),
        body: input.body ?? "",
        priority: input.priority ?? "none",
        assigneeId: input.assigneeId ?? null,
        cycleId: cycle?.id ?? null,
        projectId: inProject.projectId,
        milestoneId: inProject.milestoneId,
        parentId,
        agentClaimable: input.agentClaimable ?? actor.kind === "agent",
        position,
        createdByKind: actor.kind,
        createdById: actor.id,
      });
      await this.repo.setLabels(team, t.id, cleanLabels(input.labels ?? []));
      await this.targets.set(t.id, targets);
      const ref = `${team.key}-${t.number}`;
      await this.projects.emitIssueMove(actor, team.id, ref, null, t.projectId);
      await this.events.emit(actor, team.id, {
        type: "issue.created",
        entity: "issue",
        entityId: t.id,
        summary: `created ${ref} "${t.title}" in ${col.name}`,
        data: { ref, status: col.name, title: t.title, ...(parentId ? { parent: input.parent } : {}) },
      });
      const [withLabel] = await this.decorate([t]);
      return { row: t, out: { ...withLabel, ref, status: col.name } };
    });
    if (made.row.assigneeId) await this.notices.assigned(actor, team, made.row, made.out.ref);
    return made.out;
  }

  /**
   * Patch an issue. Pass `expectedVersion` for optimistic locking: if someone
   * (human or agent) changed the issue since you read it, you get a 409 with
   * the current state instead of silently overwriting their change.
   */
  async updateIssue(actor: Actor, ref: string, patch: IssueInput, expectedVersion?: number) {
    const { out, assigned, delegated, delegation } = await this.applyUpdate(actor, ref, patch, expectedVersion);
    if (assigned) await this.notices.assigned(actor, assigned.team, assigned.row, out.ref);
    if (delegated) await this.notices.delegated(actor, delegated.team, delegated.row, out.ref, delegated.agent);
    if (delegation) await this.emitter.emitAsync(ISSUE_DELEGATED, { actor, issueId: out.id, ref: out.ref, agentId: delegation.agentId } satisfies IssueDelegated);
    return this.bindSession(actor, out);
  }

  /** The updated issue, and (when its assignee changed to someone) what the inbox needs to tell them, once the transaction has committed. */
  private applyUpdate(actor: Actor, ref: string, patch: IssueInput, expectedVersion?: number) {
    return this.db.transaction(async () => {
      const resolved = await this.resolveIssue(actor, ref, "edit");
      const { team, ref: r } = resolved;
      const locked = await this.repo.lockIssue(resolved.issue);
      const [issue] = await this.decorate([locked]);
      if (expectedVersion !== undefined && expectedVersion !== issue.version) {
        throw new ServiceError("conflict", `${r} was changed (version ${issue.version}, you had ${expectedVersion}). Re-read and retry.`, {
          current: issue,
        });
      }
      const clean: IssueInput = {};
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
      if (clean.labels) {
        const want = cleanLabels(clean.labels);
        if (sameLabels(want, issue.labels)) delete clean.labels;
        else clean.labels = want;
      }
      await this.assertAssignee(team.id, clean.assigneeId);
      const { projectId: wantProject, milestoneId: wantMilestone, parent: wantParent, delegate: wantDelegate, targets: wantTargets, ...cleanRest } = clean;
      const parentChange = wantParent === undefined ? {} : { parentId: await this.resolveParent(team, issue.id, wantParent) };
      const delegateId = wantDelegate === undefined ? undefined : await this.resolveDelegate(actor, team, issue, wantDelegate);
      const delegateChange = delegateId === undefined ? {} : { delegateAgentId: delegateId };
      const projectChoice =
        wantProject === undefined && wantMilestone === undefined
          ? undefined
          : await this.projects.resolveIssueProject(team, { projectId: issue.projectId, milestoneId: issue.milestoneId }, { project: wantProject, milestone: wantMilestone });
      const changes = diff(issue as unknown as Record<string, unknown>, { ...cleanRest, ...(projectChoice ?? {}), ...parentChange, ...delegateChange } as Record<string, unknown>);
      const newTargets = wantTargets === undefined ? undefined : await this.targets.resolve({ teamId: team.id, projectId: projectChoice ? projectChoice.projectId : issue.projectId }, wantTargets);
      if (newTargets) {
        const was = await this.targets.own(issue.id);
        if (JSON.stringify(was) !== JSON.stringify(newTargets)) changes.targets = { from: was, to: newTargets };
      }
      if (!Object.keys(changes).length) return { out: { ...issue, ref: r }, assigned: null, delegated: null, delegation: null };
      const { labels: newLabels, cycle: newCycle, ...columnsPatch } = cleanRest;
      const cycleChange = newCycle === undefined ? {} : { cycleId: newCycle === null ? null : (await this.cycles.cycleForIssue(team.id, newCycle)).id };
      const row = await this.repo.updateIssue(issue.id, { ...columnsPatch, ...cycleChange, ...(projectChoice ?? {}), ...parentChange, ...delegateChange, ...("delegateAgentId" in changes ? { delegatedBy: delegateId ? actor.id : null, delegatedAt: delegateId ? new Date() : null } : {}), version: issue.version + 1, updatedAt: new Date() });
      if (newLabels) await this.repo.setLabels(team, row.id, newLabels);
      if (newTargets && "targets" in changes) await this.targets.set(row.id, newTargets);
      const t = { ...row, labels: newLabels ?? issue.labels, cycle: newCycle === undefined ? issue.cycle : newCycle };
      await this.projects.emitIssueMove(actor, team.id, r, issue.projectId, row.projectId);
      await this.events.emit(actor, team.id, {
        type: "issue.updated",
        entity: "issue",
        entityId: t.id,
        summary: `updated ${r}: ${Object.keys(changes).join(", ")}`,
        data: { ref: r, changes },
      });
      const assigned = "assigneeId" in changes && row.assigneeId ? { team, row } : null;
      // The assignee hears when someone else hands their issue to an agent (the inbox never tells people what they did themselves).
      const delegated = "delegateAgentId" in changes && wantDelegate ? { team, row, agent: wantDelegate } : null;
      const delegation = "delegateAgentId" in changes ? { agentId: row.delegateAgentId } : null;
      return { out: { ...t, ref: r }, assigned, delegated, delegation };
    });
  }

  async moveIssue(actor: Actor, ref: string, status: string, index?: number, expectedVersion?: number) {
    const { out, review } = await this.applyMove(actor, ref, status, index, expectedVersion);
    if (review) await this.notices.movedToReview(actor, review.team, review.row, out.ref);
    return this.bindSession(actor, out);
  }

  private applyMove(actor: Actor, ref: string, status: string, index?: number, expectedVersion?: number) {
    return this.db.transaction(async () => {
      const resolved = await this.resolveIssue(actor, ref, "edit");
      const { team, ref: r } = resolved;
      const locked = await this.repo.lockIssue(resolved.issue);
      const [issue] = await this.decorate([locked]);
      if (expectedVersion !== undefined && expectedVersion !== issue.version) {
        throw new ServiceError("conflict", `${r} was changed since you read it`, { current: issue });
      }
      const to = await this.resolveStatus(team.id, status);
      const from = (await this.repo.statusById(issue.statusId))!;
      const position = await this.positionAt(to.id, index, issue.id);
      const moved = await this.repo.updateIssue(issue.id, { statusId: to.id, position, version: issue.version + 1, updatedAt: new Date() });
      const t = { ...moved, labels: issue.labels, cycle: issue.cycle };
      if (from.id !== to.id) {
        await this.events.emit(actor, team.id, {
          type: "issue.moved",
          entity: "issue",
          entityId: t.id,
          summary: `moved ${r} from ${from.name} → ${to.name}`,
          data: { ref: r, from: from.name, to: to.name, fromRole: from.role, toRole: to.role },
        });
      }
      const review = from.id !== to.id && to.role === "review" ? { team, row: moved } : null;
      return { out: { ...t, ref: r, status: to.name }, review };
    });
  }

  async deleteIssue(actor: Actor, ref: string) {
    return this.db.transaction(async () => {
      const { issue, team, ref: r } = await this.resolveIssue(actor, ref, "edit");
      await this.repo.deleteIssue(issue.id);
      await this.events.emit(actor, team.id, {
        type: "issue.deleted",
        entity: "issue",
        entityId: issue.id,
        summary: `deleted ${r} "${issue.title}"`,
        data: { ref: r, title: issue.title },
      });
      return { ok: true };
    });
  }

  /** Agent claims an issue it's about to work on (only if humans marked it claimable). */
  async claimIssue(actor: Actor, ref: string) {
    if (actor.kind !== "agent") throw new ServiceError("forbidden", "Only agents claim issues");
    const t = await this.db.transaction(async () => {
      const { issue, team, ref: r } = await this.resolveIssue(actor, ref, "edit");
      if (!issue.agentClaimable) throw new ServiceError("forbidden", `${r} is not marked agent-claimable by the workspace`);
      if (issue.claimedByKeyId && issue.claimedByKeyId !== actor.id) throw new ServiceError("conflict", `${r} is already claimed by another agent`);
      const claimed = await this.repo.updateIssue(issue.id, { claimedByKeyId: actor.id, version: issue.version + 1, updatedAt: new Date() });
      const [t] = await this.decorate([claimed]);
      await this.events.emit(actor, team.id, { type: "issue.claimed", entity: "issue", entityId: t.id, summary: `claimed ${r}`, data: { ref: r } });
      return { ...t, ref: r };
    });
    return this.bindSession(actor, t);
  }

  /** An agent working an issue binds it to its active session (for the reconciliation check). */
  async bindSession<T extends { id: string; teamId: string }>(actor: Actor, t: T): Promise<T> {
    if (actor.kind === "agent") await this.sessions.noteIssueActivity(actor, t.teamId, t.id);
    return t;
  }

  async addComment(actor: Actor, ref: string, body: string) {
    if (!body?.trim()) throw new ServiceError("invalid", "Comment body is required");
    const { c, issue, team, r } = await this.db.transaction(async () => {
      const { issue, team, ref: r } = await this.resolveIssue(actor, ref, "edit");
      const c = await this.repo.insertComment({ issueId: issue.id, authorKind: actor.kind, authorId: actor.id, authorName: actor.name, body: body.trim() });
      await this.events.emit(actor, team.id, {
        type: "comment.created",
        entity: "issue",
        entityId: issue.id,
        summary: `commented on ${r}`,
        data: { ref: r, commentId: c.id, body: c.body },
      });
      return { c, issue, team, r };
    });
    await this.notices.commented(actor, team, issue, r, c);
    await this.emitter.emitAsync(ISSUE_COMMENTED, { actor, issueId: issue.id, ref: r, body: c.body } satisfies IssueCommented);
    await this.bindSession(actor, issue);
    return c;
  }

  /** The comment as the web app shows it: the row plus who wrote it, with a face. */
  async withAuthor(actor: Actor, c: CommentRow) {
    const [author] = await this.actors.resolve(actor.workspaceId, [{ kind: c.authorKind, id: c.authorId, agentId: c.authorAgentId, name: c.authorName }]);
    return { ...c, author };
  }

  /**
   * WH-119: no one edits a comment (an agent's stays as it wrote it; people reply under it), but a team admin can delete one, for
   * example a run's summary that leaked a secret. The event records who and whose, never the text.
   */
  async deleteComment(actor: Actor, ref: string, commentId: string) {
    if (!isUuid(commentId)) throw new ServiceError("not_found", "Comment not found");
    return this.db.transaction(async () => {
      const { issue, team, ref: r } = await this.resolveIssue(actor, ref, "admin");
      const c = await this.repo.deleteComment(issue.id, commentId);
      if (!c) throw new ServiceError("not_found", "Comment not found");
      await this.events.emit(actor, team.id, {
        type: "comment.deleted",
        entity: "issue",
        entityId: issue.id,
        summary: `deleted a comment by ${c.authorName} on ${r}`,
        data: { ref: r, commentId: c.id, authorKind: c.authorKind, authorName: c.authorName },
      });
      return { ok: true };
    });
  }

  /** Link an issue to a map node, or unlink it. This module owns issue_nodes: the table is written only from an issue. */
  async linkIssueNode(actor: Actor, issueRef: string, nodeRef: string, unlink = false) {
    return this.db.transaction(async () => {
      const { issue, team, ref } = await this.resolveIssue(actor, issueRef, "edit");
      const n = await this.graph.resolveNode(team.id, nodeRef);
      if (unlink) await this.repo.unlinkNode(issue.id, n.id);
      else await this.repo.linkNode(issue.id, n.id);
      await this.events.emit(actor, team.id, {
        type: unlink ? "issue.unlinked" : "issue.linked",
        entity: "issue",
        entityId: issue.id,
        summary: `${unlink ? "unlinked" : "linked"} ${ref} ${unlink ? "from" : "to"} "${n.name}"`,
        data: { ref, node: n.name },
      });
      return { ok: true };
    });
  }

  // ───────── what the web app reads and writes ─────────

  /**
   * A stale `version` is a 409 whose `details.current` is what the issue is now. The service attaches the raw row; the web app is
   * given the same trimmed issue every other answer uses, so the screen can show the conflict and offer the latest text.
   */
  private async withCurrent<T>(actor: Actor, ref: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof ServiceError && e.code === "conflict" && (e.details as { current?: unknown } | undefined)?.current) {
        const now = await this.resolveIssue(actor, ref);
        const [withLabel] = await this.decorate([now.issue]);
        throw new ServiceError("conflict", e.message, { current: issueView({ ...withLabel, ref: now.ref }) });
      }
      throw e;
    }
  }

  async createIssueAs(actor: Actor, teamKey: string, input: IssueInput & { title: string }, status?: string) {
    const t = await this.createIssue(actor, teamKey, { ...input, status });
    return { ...issueView(t), status: t.status };
  }

  /** Change fields. With `version`, a change made by anyone since is refused (409) and nothing is overwritten. */
  async updateIssueAs(actor: Actor, ref: string, patch: IssueInput, version?: number) {
    const t = await this.withCurrent(actor, ref, () => this.updateIssue(actor, ref, patch, version));
    return issueView(t);
  }

  /** Move to a status (an id, a name or a role such as "review") at a position (the end when absent). */
  async moveIssueAs(actor: Actor, ref: string, status: string, index?: number, version?: number) {
    const t = await this.withCurrent(actor, ref, () => this.moveIssue(actor, ref, status, index, version));
    return { ...issueView(t), status: t.status };
  }
}
