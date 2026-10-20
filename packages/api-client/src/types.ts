/** The shapes the web app's API answers with (JSON: every date is an ISO string). Kept by hand and checked by the contract suite. */

export type Role = "owner" | "admin" | "member" | "viewer" | "guest";

/** A workspace the person belongs to. `active` is the one this session is working in. */
export type WorkspaceChoice = { id: string; name: string; role: Role; active: boolean };

// ───────── who is in a team (ADR-23) ─────────

export type TeamRole = "admin" | "editor" | "viewer";
export type TeamMember = { userId: string; name: string; email: string; role: TeamRole; workspaceRole: Role; addedAt: string };
export type TeamMembers = {
  team: { id: string; key: string; name: string };
  /** The caller's own role in the team. */
  myRole: TeamRole | null;
  members: TeamMember[];
};
/** A workspace member who is not in the team yet. */
export type AddableMember = { userId: string; name: string; email: string; workspaceRole: Role };
/** One team of the workspace by name (owners and admins): who administers it and whether the caller is in it. */
export type WorkspaceTeam = { id: string; key: string; name: string; admins: string[]; memberCount: number; isMember: boolean };
export type AuditEvent = {
  seq: number;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string | null;
  teamKey: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
};

// ───────── workspace, members, keys, invites ─────────

export type WorkspaceMember = { userId: string; name: string; email: string; role: Role; tags: string[] };
export type Seats = { members: number; pending: number; used: number; max: number; full: boolean };

export type PendingInvite = {
  id: string;
  kind: "new_workspace" | "join_workspace";
  email: string;
  role: Role;
  workspaceName: string | null;
  /** The teams they join on accepting. */
  teams: { key: string; name: string; role: TeamRole }[];
  createdAt: string;
  expiresAt: string;
};

export type WorkspaceOverview = {
  workspace: { id: string; name: string };
  role: Role;
  members: WorkspaceMember[];
  seats: Seats;
  /** Join invites still waiting. Empty for a member: only owners see them. */
  pendingInvites: PendingInvite[];
};

export type KeyView = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; canWriteDocs: boolean };

/** Every command the Agents page asks someone to paste. None of them carries a key. */
export type SetupCommands = {
  teamKey: string;
  url: string;
  installPlugin: string;
  marketplace: string;
  vscodeInstallLink: string;
  loginOptional: string;
  linkRepo: string;
  buildMap: string;
  refreshMap: string;
  mcpBuildMap: string;
  mcpRefreshMap: string;
  cli: string;
  mcp: string;
  rest: string;
};

export type AgentsPage = { keys: KeyView[]; setup: SetupCommands };
export type CreatedKey = { key: KeyView; secret: string };

export type CreateInviteInput = { kind: "join_workspace" | "new_workspace"; email: string; role?: Role; tags?: string[] | string; workspace?: string; /** join_workspace only: the teams the person joins on accepting, by key. The caller must administer each. */ teams?: { team: string; role: TeamRole }[] };
export type CreatedInvite = { id: string; email: string; kind: "new_workspace" | "join_workspace"; expiresAt: string; link: string };
export type InvitePeek = { email: string; kind: "new_workspace" | "join_workspace"; workspaceName: string | null };
/** What an invite sent to a signed-in person's own address would add them to. */
export type InvitePeekExisting = { email: string; workspaceName: string; role: Role; teams: { key: string; name: string; role: TeamRole }[] };
export type AcceptInviteInput = { token: string; name: string; password: string; confirm: string };

// ───────── instance admin ─────────

export type AdminWorkspace = {
  id: string;
  name: string;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  owners: { name: string; email: string }[];
  members: number;
  pendingInvites: number;
  seatsUsed: number;
  maxSeats: number;
  teams: number;
  lastActivity: string | null;
  invitedBy: { name: string; email: string } | null;
  isYours: boolean;
};

export type AdminWorkspaceDetail = AdminWorkspace & {
  suspendedBy: { name: string; email: string } | null;
  memberList: { userId: string; name: string; email: string; role: Role; tags: string[]; joinedAt: string }[];
  inviteList: { id: string; kind: "new_workspace" | "join_workspace"; email: string; role: string; status: "pending" | "used" | "revoked" | "expired"; expiresAt: string; createdAt: string }[];
  keys: { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[];
};

// ───────── dashboard ─────────

export type DashboardSummary = {
  teams: number;
  open: number;
  inProgress: number;
  inReview: number;
  completed7d: number;
  completedPrev7d: number;
  agentShare7d: number | null;
  events7d: number;
  staleNodes: number;
  mapNodes: number;
  staleDocs: number;
  agents: number;
  /** Different agents that changed something in these teams in the last 7 days. */
  agentsActive7d: number;
};

/** The most important things about one team, ranked for a quick look. Only for `?team=KEY`. */
export type FocusTicket = { ref: string; title: string; column: string; priority: Priority; days: number; byAgent: boolean };
export type TeamFocus = {
  /** In progress the longest, oldest first. */
  aging: FocusTicket[];
  /** Waiting for review the longest, oldest first. */
  waitingReview: FocusTicket[];
  /** Tickets an agent claimed and went quiet on. */
  quiet: { ref: string; title: string; teamKey: string; agent: string; lastAt: string }[];
  proposedDecisions: number;
  members: { count: number; myRole: string | null };
  tickets: number;
};

export type TeamProgress = {
  id: string;
  key: string;
  name: string;
  total: number;
  done: number;
  pct: number;
  stages: { id: string; name: string; count: number }[];
  urgent: number;
  agentReady: number;
  staleNodes: number;
  mapNodes: number;
  staleDocs: number;
  lastActivity: string | null;
};

export type ThroughputDay = { day: string; created: number; completed: number };
export type ActivityDay = { day: string; human: number; agent: number };

export type SessionView = {
  id: string;
  pending: number;
  lastSeenAt: string;
  bucket: "h6" | "h12" | "h24" | "d7";
  reading: boolean;
  branch: string | null;
  ticket: string | null;
  teamKey?: string;
};

export type AgentQueue = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  pending: number;
  byTeam: { key: string; pending: number }[];
  sessions: SessionView[];
  actions7d: number;
};

export type NeedsAttention = {
  review: { ref: string; title: string; teamKey: string; byAgent: boolean; updatedAt: string }[];
  urgent: { ref: string; title: string; teamKey: string; column: string }[];
  stale: { id: string; name: string; layer: string; reason: string | null; teamKey: string }[];
  staleDocs: { id: string; slug: string; title: string; reason: string | null; teamKey: string }[];
};

export type ActivityEvent = { seq: number; teamKey: string; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: string };

export type SyncHealth = {
  untracked: { id: string; teamKey: string; by: string; files: string[]; since: string }[];
  quiet: { ref: string; title: string; teamKey: string; agent: string; lastAt: string }[];
  drafts: { id: string; teamKey: string; nodeId: string; node: string; authorName: string; confirm: boolean; createdAt: string }[];
};

/** The dashboard's widgets by the name of their endpoint (`GET /api/app/dashboard/:widget`). */
export type DashboardWidgets = {
  kpis: DashboardSummary;
  progress: TeamProgress[];
  throughput: ThroughputDay[];
  "activity-split": ActivityDay[];
  agents: AgentQueue[];
  attention: NeedsAttention;
  recent: ActivityEvent[];
  sync: SyncHealth;
  /** One team only: ask with `team`. */
  focus: TeamFocus;
};

// ───────── the board and its tickets ─────────

export type Priority = "low" | "medium" | "high" | "urgent";

export type TicketView = {
  id: string;
  ref: string;
  number: number;
  title: string;
  body: string;
  columnId: string;
  priority: Priority;
  assigneeId: string | null;
  agentClaimable: boolean;
  claimedByKeyId: string | null;
  labels: string[];
  /** The number of the cycle it is in, or null. */
  cycle: number | null;
  /** The project and milestone it is in (ids; the board's `projects` names them). */
  projectId: string | null;
  milestoneId: string | null;
  position: number;
  version: number;
  createdByKind: "human" | "agent";
  createdAt: string;
  updatedAt: string;
};

/** A ticket on the board also says which map nodes it touches and how many comments it has. */
export type BoardTicket = TicketView & { nodeIds: string[]; commentCount: number };

export type ChecklistItem = {
  id: "repos" | "machines" | "agents" | "map" | "teammates";
  label: string;
  done: boolean;
  status: string;
  href: string;
};
export type ChecklistState = { items: ChecklistItem[]; done: boolean; doneCount: number; total: number };

// ───────── cycles ─────────

export type CycleState = "upcoming" | "current" | "past";
export type CycleOption = { number: number; name: string; startsAt: string; endsAt: string; state: CycleState };
export type CycleSummary = CycleOption & {
  goal: string;
  /** Tickets in the cycle now, how many of them are done, and how many are still open. */
  total: number;
  done: number;
  open: number;
};
export type CycleList = { current: CycleSummary | null; upcoming: CycleSummary[]; past: CycleSummary[] };
export type CycleLanded = { ref: string; title: string; ticketId: string; doneAt: string; inCycle: boolean };
export type CycleDetail = CycleSummary & {
  tickets: { ref: string; title: string; priority: Priority; column: string; done: boolean; assigneeId: string | null }[];
  /** Tickets that reached Done while the cycle ran, and which of them are in it. */
  landed: CycleLanded[];
};
/** No dates: from now for two weeks. A cycle lasts one to fourteen days and does not overlap another of the team. */
export type CycleInput = { name?: string; goal?: string; startsAt?: string; endsAt?: string };

// ───────── projects ─────────

export type ProjectStatus = "planned" | "active" | "paused" | "completed" | "canceled";
export type ProjectHealthValue = "on_track" | "at_risk" | "off_track";
/** What the tickets and dates say (`derived`, only for an active project), what someone set (`override`), and the one to show. */
export type ProjectHealth = { derived: ProjectHealthValue | null; override: ProjectHealthValue | null; value: ProjectHealthValue | null };

export type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  health: ProjectHealth;
  startDate: string | null;
  targetDate: string | null;
  leadUser: { id: string; name: string } | null;
  /** Named only to people on the lead team. */
  leadTeam: { key: string; name: string } | null;
  /** Every ticket in the project, across all its teams, and how many are done. */
  total: number;
  done: number;
  teamCount: number;
  version: number;
  canEdit: boolean;
  updatedAt: string;
};
export type ProjectMilestone = { id: string; name: string; description: string; targetDate: string | null; position: number; total: number; done: number };
export type ProjectTicket = { ref: string; title: string; priority: Priority; column: string; done: boolean; milestoneId: string | null };
export type ProjectTeam = { key: string; name: string; role: TeamRole; lead: boolean; total: number; done: number; tickets: ProjectTicket[] };
export type ProjectDetail = ProjectSummary & {
  canAdmin: boolean;
  milestones: ProjectMilestone[];
  /** The teams of the project the viewer is on, with their tickets. */
  teams: ProjectTeam[];
  /** The teams they are not on: how many and the totals of their tickets, never a name or a title. */
  others: { count: number; total: number; done: number };
  /** Teams the viewer could bring in (they edit them) and that do not take part yet. */
  addableTeams: { key: string; name: string }[];
};
export type ProjectInput = {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  startDate?: string | null;
  targetDate?: string | null;
  leadUser?: string | null;
  leadTeam?: string;
  /** `null` clears a health that was set by hand. */
  healthOverride?: ProjectHealthValue | null;
  /** When creating: the keys of the other teams taking part. */
  teams?: string[];
  /** The version last read, so an edit made since is refused. */
  version?: number;
};
export type MilestoneInput = { name?: string; description?: string; targetDate?: string | null; index?: number };
export type InitiativeStatus = "planned" | "active" | "paused" | "done";
export type InitiativeSummary = {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  status: InitiativeStatus;
  health: ProjectHealth;
  targetDate: string | null;
  owner: { id: string; name: string } | null;
  /** Rolled up from the tickets of every project below, each ticket once. */
  total: number;
  done: number;
  /** Projects linked to this initiative itself, and initiatives directly under it. */
  projectCount: number;
  childCount: number;
  /** 1 for a top initiative; at most 3. */
  depth: number;
  version: number;
  canEdit: boolean;
  updatedAt: string;
};
export type InitiativeProject = { id: string; name: string; status: ProjectStatus; health: ProjectHealth; targetDate: string | null; total: number; done: number; direct: boolean };
export type InitiativeDetail = InitiativeSummary & {
  /** From the top initiative down to the parent. */
  path: { id: string; name: string }[];
  children: InitiativeSummary[];
  /** Projects of the viewer's teams that it reaches. `direct`: linked here rather than only through a sub-initiative. */
  projects: InitiativeProject[];
  /** The other projects it reaches: how many and their totals, never a name. */
  hidden: { count: number; total: number; done: number };
  /** Projects the viewer sees that are not linked here yet (only when they can edit it). */
  linkable: { id: string; name: string }[];
};
export type InitiativeInput = {
  name?: string;
  description?: string;
  status?: InitiativeStatus;
  targetDate?: string | null;
  owner?: string | null;
  parentId?: string | null;
  /** `null` clears a health that was set by hand. */
  healthOverride?: ProjectHealthValue | null;
  /** Its place among its siblings, from 0. */
  index?: number;
  version?: number;
};
export type TeamProjectOption = { id: string; name: string; status: ProjectStatus; milestones: { id: string; name: string }[] };

export type BoardColumn = { id: string; name: string; role: string | null; position: number };
export type BoardNode = { id: string; name: string; kind: string; parentId: string | null; layer: string };
export type BoardMember = { id: string; name: string };

export type BoardView = {
  team: { id: string; key: string; name: string; description: string };
  columns: BoardColumn[];
  tickets: BoardTicket[];
  nodes: BoardNode[];
  members: BoardMember[];
  /** The team's cycles, newest first: a card's chip names one, the filter lists them. */
  cycles: CycleOption[];
  /** The projects this team takes part in, with their milestones: for the card chip and the ticket's Project field. */
  projects: TeamProjectOption[];
  checklist: ChecklistState;
};

export type TicketComment = { id: string; authorKind: "human" | "agent"; authorName: string; body: string; createdAt: string };
export type TicketHistoryItem = { seq: number; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: string };
export type TicketPullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  ciState: string | null;
  headBranch: string | null;
  repository: string;
  updatedAt: string;
};

export type TicketDetail = {
  ticket: TicketView & { column: string | undefined };
  team: { key: string; name: string };
  comments: TicketComment[];
  nodes: { id: string; name: string; kind: string; parentId: string | null }[];
  history: TicketHistoryItem[];
  pullRequests: TicketPullRequest[];
};

/** The fields of a ticket a person can change. `version` is what you last read: a change by anyone since is a 409 conflict. */
export type TicketPatch = {
  title?: string;
  body?: string;
  priority?: Priority;
  assigneeId?: string | null;
  agentClaimable?: boolean;
  labels?: string[];
  /** A cycle number of this team that has not ended; null takes the ticket out of its cycle. */
  cycle?: number | null;
  /** A project this team takes part in; null takes the ticket out of it (and its milestone). */
  projectId?: string | null;
  /** A milestone of the ticket's project; null clears it. */
  milestoneId?: string | null;
  version?: number;
};
export type NewTicket = Omit<TicketPatch, "version"> & { title: string; column?: string };
export type MoveTicket = { column: string; index?: number; version?: number };

export type BotSession = SessionView;
/** An agent key and its queue in one team. */
export type Bot = { id: string; name: string; pending: number; lastUsedAt: string | null; sessions: BotSession[] };

// ───────── the map, decisions, glossary and activity ─────────

export type LayerId = "concept" | "system" | "data" | "code";
export type NodeStatus = "planned" | "building" | "live" | "deprecated";

export type MapColumn = {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  unique?: boolean;
  default?: string;
  references?: string;
  onDelete?: string;
  note?: string;
};
export type MapIndex = { name?: string; columns: string[]; unique?: boolean };

export type MapNode = {
  id: string;
  parentId: string | null;
  layer: LayerId;
  kind: string;
  name: string;
  summary: string;
  purpose: string;
  responsibilities: string;
  interfaces: string;
  gotchas: string;
  details: string;
  anchors: string[];
  columns: MapColumn[];
  indexes: MapIndex[];
  describedSha: string | null;
  describedAt: string | null;
  stale: boolean;
  staleReason: string | null;
  status: NodeStatus;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  placed: boolean;
  version: number;
};

export type MapEdgeMeta = { fromColumn?: string; toColumn?: string; cardinality?: "1-1" | "n-1" | "1-n" | "n-m"; onDelete?: string; derived?: boolean };
export type MapEdge = { id: string; kind: string; fromNodeId: string; toNodeId: string; label: string; meta: MapEdgeMeta };
export type FlowStep = { nodeId: string; title: string; detail: string };
export type Flow = { id: string; name: string; description: string; steps: FlowStep[]; version: number };
export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";
export type Decision = {
  id: string;
  number: number;
  title: string;
  status: DecisionStatus;
  context: string;
  decision: string;
  consequences: string;
  nodeIds: string[];
  authorKind: "human" | "agent";
  authorName: string;
  version: number;
  updatedAt: string;
};
export type Term = { id: string; term: string; definition: string; nodeId: string | null };

export type FluxEntry = {
  sessions: { id: string; by: string; ticket: string | null; files: string[] }[];
  drafts: { id: string; authorKind: "human" | "agent"; authorName: string; confirm: boolean; patch: Record<string, unknown> }[];
};

export type GraphView = {
  team: { id: string; key: string; name: string; description: string };
  nodes: MapNode[];
  edges: MapEdge[];
  ticketLinks: { nodeId: string; ticketId: string; number: number; title: string; columnId: string; ref: string }[];
  flows: Flow[];
  decisions: Decision[];
  terms: Term[];
  flux: Record<string, FluxEntry>;
  askEnabled: boolean;
};

/** The fields of a node a person can change. `version` is the lock: a change made since is a 409 whose `current` is the node now. */
export type NodePatch = {
  id?: string;
  name?: string;
  layer?: LayerId;
  kind?: string;
  status?: NodeStatus;
  parent?: string | null;
  summary?: string;
  purpose?: string;
  responsibilities?: string;
  interfaces?: string;
  gotchas?: string;
  details?: string;
  anchors?: string[];
  columns?: MapColumn[];
  indexes?: MapIndex[];
  version?: number;
};
export type NodePosition = { id: string; x: number; y: number; width?: number; height?: number };
export type FlowInput = { id?: string; name: string; description?: string; steps?: { node: string; title: string; detail?: string }[]; version?: number };
export type DecisionInput = {
  number?: number;
  title?: string;
  status?: DecisionStatus;
  context?: string;
  decision?: string;
  consequences?: string;
  nodes?: string[];
  version?: number;
};
export type AskAnswer = { answer: string; truncated: boolean };
export type ActivityEvent2 = {
  seq: number;
  actorKind: "human" | "agent";
  actorName: string;
  type: string;
  entity: string;
  entityId: string | null;
  summary: string;
  data: { ref?: string; number?: number; body?: string };
  createdAt: string;
};

// ───────── docs, repositories, onboarding (WH-98) ─────────

export type DocTreeItem = { id: string; parentId: string | null; slug: string; title: string; version: number; position: number; updatedAt: string; stale: boolean };
export type Doc = DocTreeItem & {
  body: string;
  anchors: string[];
  labels: string[];
  staleReason: string | null;
  updatedByKind: "human" | "agent";
  updatedById: string | null;
  createdAt: string;
};
export type DocsIndex = {
  docs: DocTreeItem[];
  nodes: { id: string; name: string; layer: LayerId; parentId: string | null }[];
  decisions: { id: string; number: number; title: string }[];
  members: { id: string; name: string }[];
};
export type DocPerson = { kind: "human" | "agent"; id: string | null; name: string };
/** `owner` created the doc; `contributors` are everyone else who changed it. */
export type DocDetail = { doc: Doc; nodes: { id: string; name: string; kind: string; layer: LayerId }[]; owner: DocPerson; contributors: DocPerson[] };
export type DocTemplateId = "spec" | "decision-record" | "runbook" | "meeting-notes" | "onboarding";
export type NewDoc = { title: string; body?: string; parent?: string | null; template?: DocTemplateId };
export type DocPatch = { title?: string; body?: string; anchors?: string[]; labels?: string[]; version?: number };

export type RepoLifecycle = "live" | "being_replaced" | "planned" | "retired";
export type Repository = {
  id: string;
  displayName: string;
  role: string;
  provider: "github" | "local";
  slug: string;
  githubFullName: string | null;
  defaultBranch: string;
  pathLimit: string | null;
  lifecycle: RepoLifecycle;
  lastEventAt: string | null;
  /** A GitHub repository whose file tree can be browsed (the doc anchor picker). */
  browsable: boolean;
};
export type RepositoryInput = {
  displayName?: string;
  role?: string;
  provider?: "github" | "local";
  defaultBranch?: string;
  pathLimit?: string | null;
  lifecycle?: RepoLifecycle;
};
export type GithubStatus = {
  configured: boolean;
  /** Owners only: the settings an administrator must set to turn GitHub on. */
  missing: string[];
  isOwner: boolean;
  installations: { installationId: string; account: string; failed: boolean; repositories: { id: string; fullName: string; private: boolean }[] }[];
};
export type OnboardingPage = { team: { key: string; name: string }; hasRepos: boolean; setup: SetupCommands };
