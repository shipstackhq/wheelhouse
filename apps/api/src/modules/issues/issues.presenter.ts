import type { PRIORITIES } from "../../db/schema";
import type { ChecklistState } from "../dashboard/index";
import type { DeliveriesService } from "../github/index";
import type { CycleOption } from "./cycles.service";
import type { IssueRelative, IssueWithLinks } from "./issues.service";
import type { TeamProjectOption } from "./projects.service";
import type { IssueRow } from "./issues.repository";

/**
 * Rows as the web app's board and issue dialog (WH-96) read them: only what the screens use, never raw rows. Pure functions; the
 * services find the data (scoped by the actor's workspace, so another workspace's team or issue is simply "not found").
 */

type PullRequests = Awaited<ReturnType<DeliveriesService["pullRequestsForIssue"]>>;

export type IssueView = {
  id: string;
  ref: string;
  number: number;
  title: string;
  body: string;
  statusId: string;
  priority: (typeof PRIORITIES)[number];
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

export const issueView = (t: IssueRow & { ref: string; labels: string[]; cycle: number | null }): IssueView => ({
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

type BoardPage = {
  board: {
    team: { id: string; key: string; name: string; description: string };
    statuses: { id: string; name: string; role: string; isDefault: boolean; color: string | null; position: number }[];
    issues: IssueWithLinks[];
  };
  nodes: BoardView["nodes"];
  members: BoardView["members"];
  cycles: CycleOption[];
  projects: TeamProjectOption[];
  checklist: ChecklistState;
};

/** The team page: its statuses, every issue, the map nodes an issue can link to, the team's members and the setup checklist. */
export const boardView = ({ board, nodes, members, cycles, projects, checklist }: BoardPage): BoardView => ({
  team: { id: board.team.id, key: board.team.key, name: board.team.name, description: board.team.description },
  statuses: board.statuses.map((c) => ({ id: c.id, name: c.name, role: c.role, isDefault: c.isDefault, color: c.color, position: c.position })),
  issues: board.issues.map((t) => ({ ...issueView(t), nodeIds: t.nodeIds, commentCount: t.commentCount })),
  nodes,
  members,
  cycles,
  projects,
  checklist,
});

export type IssueDetail = {
  issue: IssueView & { status: string | undefined };
  team: { key: string; name: string };
  comments: { id: string; authorKind: "human" | "agent"; authorName: string; body: string; createdAt: Date }[];
  nodes: { id: string; name: string; kind: string; parentId: string | null }[];
  history: { seq: number; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: Date }[];
  pullRequests: PullRequests;
  /** The issue above this one, and the ones directly under it. */
  parent: IssueRelative | null;
  children: IssueRelative[];
};

type IssuePage = {
  issue: IssueRow & { ref: string; labels: string[]; cycle: number | null; status: string | undefined };
  team: { key: string; name: string };
  comments: { id: string; authorKind: "human" | "agent"; authorName: string; body: string; createdAt: Date }[];
  nodes: IssueDetail["nodes"];
  history: { seq: number; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: Date }[];
  pullRequests: PullRequests;
  parent: IssueRelative | null;
  children: IssueRelative[];
};

/** One issue for the dialog: its fields, discussion, linked map nodes, history and the pull requests GitHub reported against it. */
export const issueDetailView = (d: IssuePage): IssueDetail => ({
  issue: { ...issueView(d.issue), status: d.issue.status },
  team: { key: d.team.key, name: d.team.name },
  comments: d.comments.map((c) => ({ id: c.id, authorKind: c.authorKind, authorName: c.authorName, body: c.body, createdAt: c.createdAt })),
  nodes: d.nodes,
  history: d.history.map((e) => ({ seq: e.seq, actorKind: e.actorKind, actorName: e.actorName, summary: e.summary, createdAt: e.createdAt })),
  pullRequests: d.pullRequests,
  parent: d.parent,
  children: d.children,
});
