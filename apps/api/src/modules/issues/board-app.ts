import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { checklistForTeam } from "../dashboard/index";
import { IssueInput, createIssue, getBoard, getIssue, moveIssue, resolveIssue, updateIssue } from "./issues";
import { withCycle, withLabels } from "./links";
import { cycleOptions, type CycleOption } from "./cycles";
import { projectsOfTeam, type TeamProjectOption } from "./projects";
import { ServiceError } from "../../common/service-error";
import type { ChecklistState } from "../dashboard/index";
import type { IssueRelative } from "./sub-issues";
/**
 * What the web app's board and issue dialog read and write (WH-96), as functions of the signed-in person. The API's controllers
 * call these and nothing else. Everything is scoped by the actor's workspace through the service layer, so another workspace's team or
 * issue is simply "not found". Responses carry only what the screens use, never raw rows.
 */

export type IssueView = {
  id: string;
  ref: string;
  number: number;
  title: string;
  body: string;
  statusId: string;
  priority: (typeof schema.PRIORITIES)[number];
  assigneeId: string | null;
  agentClaimable: boolean;
  claimedByKeyId: string | null;
  labels: string[];
  /** The number of the cycle it is in, or null. */
  cycle: number | null;
  /** The project (a deliverable that can span teams) and the milestone it is in; the board's `projects` names them. */
  projectId: string | null;
  milestoneId: string | null;
  /** The issue this is a sub-issue of (the same team's), or null. The board has every issue, so a card finds its parent from this. */
  parentId: string | null;
  position: number;
  version: number;
  createdByKind: "human" | "agent";
  createdAt: Date;
  updatedAt: Date;
};

type IssueRow = typeof schema.issues.$inferSelect & { ref: string; labels: string[]; cycle: number | null };

export const issueView = (t: IssueRow): IssueView => ({
  id: t.id,
  ref: t.ref,
  number: t.number,
  title: t.title,
  body: t.body,
  statusId: t.statusId,
  priority: t.priority,
  assigneeId: t.assigneeId,
  agentClaimable: t.agentClaimable,
  claimedByKeyId: t.claimedByKeyId,
  labels: t.labels,
  cycle: t.cycle,
  projectId: t.projectId,
  milestoneId: t.milestoneId,
  parentId: t.parentId,
  position: t.position,
  version: t.version,
  createdByKind: t.createdByKind,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

/** An issue on the board also says which map nodes it touches and how many comments it has. */
export type BoardIssue = IssueView & { nodeIds: string[]; commentCount: number };

export type BoardView = {
  team: { id: string; key: string; name: string; description: string };
  statuses: { id: string; name: string; role: string; isDefault: boolean; color: string | null; position: number }[];
  issues: BoardIssue[];
  /** Just enough of the map to show and link nodes. The map itself is another page. */
  nodes: { id: string; name: string; kind: string; parentId: string | null; layer: string }[];
  members: { id: string; name: string }[];
  /** The team's cycles, newest first: an issue's chip names one, the board filters by one. */
  cycles: CycleOption[];
  /** The projects this team takes part in, with their milestones: for the card chip and the issue's Project field. */
  projects: TeamProjectOption[];
  checklist: ChecklistState;
};

/** The team page: its statuses, every issue, the map nodes an issue can link to, the team's members (the people an issue can be assigned to) and the setup checklist. */
export async function boardView(actor: Actor, teamKey: string): Promise<BoardView> {
  const [board, checklist] = await Promise.all([getBoard(actor, teamKey), checklistForTeam(actor, teamKey)]);
  const db = await getDb();
  const [nodes, members] = await Promise.all([
    db
      .select({ id: schema.nodes.id, name: schema.nodes.name, kind: schema.nodes.kind, parentId: schema.nodes.parentId, layer: schema.nodes.layer })
      .from(schema.nodes)
      .where(eq(schema.nodes.teamId, board.team.id)),
    db
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.teamMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
      .where(eq(schema.teamMembers.teamId, board.team.id)),
  ]);
  const cycles = await cycleOptions(db, board.team.id);
  const teamProjects = await projectsOfTeam(db, board.team.id);
  return {
    team: { id: board.team.id, key: board.team.key, name: board.team.name, description: board.team.description },
    statuses: board.statuses.map((c) => ({ id: c.id, name: c.name, role: c.role, isDefault: c.isDefault, color: c.color, position: c.position })),
    issues: board.issues.map((t) => ({ ...issueView(t), nodeIds: t.nodeIds, commentCount: t.commentCount })),
    nodes,
    members,
    cycles,
    projects: teamProjects,
    checklist,
  };
}

export type IssueDetail = {
  issue: IssueView & { status: string | undefined };
  team: { key: string; name: string };
  comments: { id: string; authorKind: "human" | "agent"; authorName: string; body: string; createdAt: Date }[];
  nodes: { id: string; name: string; kind: string; parentId: string | null }[];
  history: { seq: number; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: Date }[];
  pullRequests: Awaited<ReturnType<typeof import("../github/service").pullRequestsForIssue>>;
  /** The issue above this one, and the ones directly under it. */
  parent: IssueRelative | null;
  children: IssueRelative[];
};

/** One issue for the dialog: its fields, discussion, linked map nodes, history and the pull requests GitHub reported against it. */
export async function issueDetail(actor: Actor, ref: string): Promise<IssueDetail> {
  const d = await getIssue(actor, ref);
  return {
    issue: { ...issueView(d.issue), status: d.issue.status },
    team: { key: d.team.key, name: d.team.name },
    comments: d.comments.map((c) => ({ id: c.id, authorKind: c.authorKind, authorName: c.authorName, body: c.body, createdAt: c.createdAt })),
    nodes: d.nodes,
    history: d.history.map((e) => ({ seq: e.seq, actorKind: e.actorKind, actorName: e.actorName, summary: e.summary, createdAt: e.createdAt })),
    pullRequests: d.pullRequests,
    parent: d.parent,
    children: d.children,
  };
}

// ───────── reading a request body ─────────

const bad = (field: string, message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

/** A whole number from a JSON body, or undefined when absent. Anything else (a string, 1.5, NaN) is a field error. */
export function intField(b: Record<string, unknown>, name: string): number | undefined {
  const v = b[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return bad(name, `${name} must be a whole number`);
  return v;
}

/**
 * The issue fields a request may carry, checked the way the MCP tools check them (a string, a known priority, a list of strings,
 * true or false) so a wrong type is a 400 naming the field and never reaches the database. For a new issue the title is required.
 */
export function issueInput(b: Record<string, unknown>, o: { create: boolean }): IssueInput {
  const out: IssueInput = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string") bad("title", "title must be text");
    out.title = (b.title as string).trim();
    if (!out.title) bad("title", "title is required");
  } else if (o.create) bad("title", "title is required");
  if (b.body !== undefined) {
    if (typeof b.body !== "string") bad("body", "body must be text");
    out.body = b.body as string;
  }
  if (b.priority !== undefined) {
    if (typeof b.priority !== "string" || !(schema.PRIORITIES as readonly string[]).includes(b.priority)) bad("priority", `priority must be one of ${schema.PRIORITIES.join(", ")}`);
    out.priority = b.priority as (typeof schema.PRIORITIES)[number];
  }
  if (b.assigneeId !== undefined) {
    if (b.assigneeId !== null && typeof b.assigneeId !== "string") bad("assigneeId", "assigneeId must be a person's id, or null for nobody");
    out.assigneeId = (b.assigneeId as string | null) || null;
  }
  if (b.agentClaimable !== undefined) {
    if (typeof b.agentClaimable !== "boolean") bad("agentClaimable", "agentClaimable must be true or false");
    out.agentClaimable = b.agentClaimable as boolean;
  }
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels) || b.labels.some((l) => typeof l !== "string")) bad("labels", "labels must be a list of text");
    out.labels = b.labels as string[];
  }
  for (const f of ["projectId", "milestoneId"] as const) {
    if (b[f] !== undefined) {
      if (b[f] !== null && typeof b[f] !== "string") bad(f, `${f} must be an id, or null for none`);
      out[f] = (b[f] as string | null) || null;
    }
  }
  if (b.parent !== undefined) {
    if (b.parent !== null && (typeof b.parent !== "string" || !b.parent.trim())) bad("parent", "parent must be an issue ref like WH-12, or null for none");
    out.parent = b.parent === null ? null : (b.parent as string).trim();
  }
  if (b.cycle !== undefined) {
    if (b.cycle !== null && (typeof b.cycle !== "number" || !Number.isSafeInteger(b.cycle))) bad("cycle", "cycle must be a cycle number, or null for none");
    out.cycle = b.cycle as number | null;
  }
  return out;
}

/** The status of a move or a new issue: an id, a name or a role ("review"); the service finds it in this issue's own team. */
export function statusField(b: Record<string, unknown>, required: boolean): string | undefined {
  const v = b.status;
  if (v === undefined || v === null) return required ? bad("status", "status is required") : undefined;
  if (typeof v !== "string" || !v.trim()) return bad("status", "status must be text");
  return v;
}

// ───────── changing an issue ─────────

/**
 * A stale `version` is a 409 whose `details.current` is what the issue is now. The service attaches the raw row; the web app is
 * given the same trimmed issue every other answer uses, so the screen can show the conflict and offer the latest text.
 */
async function withCurrent<T>(actor: Actor, ref: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict" && (e.details as { current?: unknown } | undefined)?.current) {
      const now = await resolveIssue(actor, ref);
      const db = await getDb();
      const [withLabel] = await withCycle(db, await withLabels(db, [now.issue]));
      throw new ServiceError("conflict", e.message, { current: issueView({ ...withLabel, ref: now.ref }) });
    }
    throw e;
  }
}

export async function createIssueAs(actor: Actor, teamKey: string, input: IssueInput & { title: string }, status?: string) {
  const t = await createIssue(actor, teamKey, { ...input, status });
  return { ...issueView(t), status: t.status };
}

/** Change fields. With `version`, a change made by anyone since is refused (409) and nothing is overwritten. */
export async function updateIssueAs(actor: Actor, ref: string, patch: IssueInput, version?: number) {
  const t = await withCurrent(actor, ref, () => updateIssue(actor, ref, patch, version));
  return issueView(t);
}

/** Move to a status (an id, a name or a role such as "review") at a position (the end when absent). */
export async function moveIssueAs(actor: Actor, ref: string, status: string, index?: number, version?: number) {
  const t = await withCurrent(actor, ref, () => moveIssue(actor, ref, status, index, version));
  return { ...issueView(t), status: t.status };
}
