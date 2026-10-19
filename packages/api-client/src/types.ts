/** The shapes the web app's API answers with (JSON: every date is an ISO string). Kept by hand and checked by the contract suite. */

export type Role = "owner" | "admin" | "member" | "viewer" | "guest";

/** A workspace the person belongs to. `active` is the one this session is working in. */
export type WorkspaceChoice = { id: string; name: string; role: Role; active: boolean };

// ───────── who is in a project (ADR-23) ─────────

export type ProjectRole = "admin" | "editor" | "viewer";
export type ProjectMember = { userId: string; name: string; email: string; role: ProjectRole; workspaceRole: Role; addedAt: string };
export type ProjectMembers = {
  project: { id: string; key: string; name: string };
  /** The caller's own role in the project. */
  myRole: ProjectRole | null;
  members: ProjectMember[];
};
/** A workspace member who is not in the project yet. */
export type AddableMember = { userId: string; name: string; email: string; workspaceRole: Role };
/** One project of the workspace by name (owners and admins): who administers it and whether the caller is in it. */
export type WorkspaceProject = { id: string; key: string; name: string; admins: string[]; memberCount: number; isMember: boolean };
export type AuditEvent = {
  seq: number;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string | null;
  projectKey: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
};

// ───────── team, members, keys, invites ─────────

export type TeamMember = { userId: string; name: string; email: string; role: Role; tags: string[] };
export type Seats = { members: number; pending: number; used: number; max: number; full: boolean };

export type PendingInvite = {
  id: string;
  kind: "new_team" | "join_team";
  email: string;
  role: Role;
  teamName: string | null;
  /** The projects they join on accepting. */
  projects: { key: string; name: string; role: ProjectRole }[];
  createdAt: string;
  expiresAt: string;
};

export type TeamOverview = {
  team: { id: string; name: string };
  role: Role;
  members: TeamMember[];
  seats: Seats;
  /** Join invites still waiting. Empty for a member: only owners see them. */
  pendingInvites: PendingInvite[];
};

export type KeyView = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; canWriteDocs: boolean };

/** Every command the Agents page asks someone to paste. None of them carries a key. */
export type SetupCommands = {
  projectKey: string;
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

export type CreateInviteInput = { kind: "join_team" | "new_team"; email: string; role?: Role; tags?: string[] | string; team?: string; /** join_team only: the projects the person joins on accepting, by key. The caller must administer each. */ projects?: { project: string; role: ProjectRole }[] };
export type CreatedInvite = { id: string; email: string; kind: "new_team" | "join_team"; expiresAt: string; link: string };
export type InvitePeek = { email: string; kind: "new_team" | "join_team"; teamName: string | null };
/** What an invite sent to a signed-in person's own address would add them to. */
export type InvitePeekExisting = { email: string; teamName: string; role: Role; projects: { key: string; name: string; role: ProjectRole }[] };
export type AcceptInviteInput = { token: string; name: string; password: string; confirm: string };

// ───────── instance admin ─────────

export type AdminTeam = {
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
  projects: number;
  lastActivity: string | null;
  invitedBy: { name: string; email: string } | null;
  isYours: boolean;
};

export type AdminTeamDetail = AdminTeam & {
  suspendedBy: { name: string; email: string } | null;
  memberList: { userId: string; name: string; email: string; role: Role; tags: string[]; joinedAt: string }[];
  inviteList: { id: string; kind: "new_team" | "join_team"; email: string; role: string; status: "pending" | "used" | "revoked" | "expired"; expiresAt: string; createdAt: string }[];
  keys: { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[];
};

// ───────── dashboard ─────────

export type DashboardSummary = {
  projects: number;
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
  /** Different agents that changed something in these projects in the last 7 days. */
  agentsActive7d: number;
};

/** The most important things about one project, ranked for a quick look. Only for `?project=KEY`. */
export type FocusTicket = { ref: string; title: string; column: string; priority: Priority; days: number; byAgent: boolean };
export type ProjectFocus = {
  /** In progress the longest, oldest first. */
  aging: FocusTicket[];
  /** Waiting for review the longest, oldest first. */
  waitingReview: FocusTicket[];
  /** Tickets an agent claimed and went quiet on. */
  quiet: { ref: string; title: string; projectKey: string; agent: string; lastAt: string }[];
  proposedDecisions: number;
  members: { count: number; myRole: string | null };
  tickets: number;
};

export type ProjectProgress = {
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
  projectKey?: string;
};

export type AgentQueue = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  pending: number;
  byProject: { key: string; pending: number }[];
  sessions: SessionView[];
  actions7d: number;
};

export type NeedsAttention = {
  review: { ref: string; title: string; projectKey: string; byAgent: boolean; updatedAt: string }[];
  urgent: { ref: string; title: string; projectKey: string; column: string }[];
  stale: { id: string; name: string; layer: string; reason: string | null; projectKey: string }[];
  staleDocs: { id: string; slug: string; title: string; reason: string | null; projectKey: string }[];
};

export type ActivityEvent = { seq: number; projectKey: string; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: string };

export type SyncHealth = {
  untracked: { id: string; projectKey: string; by: string; files: string[]; since: string }[];
  quiet: { ref: string; title: string; projectKey: string; agent: string; lastAt: string }[];
  drafts: { id: string; projectKey: string; nodeId: string; node: string; authorName: string; confirm: boolean; createdAt: string }[];
};

/** The dashboard's widgets by the name of their endpoint (`GET /api/app/dashboard/:widget`). */
export type DashboardWidgets = {
  kpis: DashboardSummary;
  progress: ProjectProgress[];
  throughput: ThroughputDay[];
  "activity-split": ActivityDay[];
  agents: AgentQueue[];
  attention: NeedsAttention;
  recent: ActivityEvent[];
  sync: SyncHealth;
  /** One project only: ask with `project`. */
  focus: ProjectFocus;
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

export type BoardColumn = { id: string; name: string; role: string | null; position: number };
export type BoardNode = { id: string; name: string; kind: string; parentId: string | null; layer: string };
export type BoardMember = { id: string; name: string };

export type BoardView = {
  project: { id: string; key: string; name: string; description: string };
  columns: BoardColumn[];
  tickets: BoardTicket[];
  nodes: BoardNode[];
  members: BoardMember[];
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
  project: { key: string; name: string };
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
  version?: number;
};
export type NewTicket = Omit<TicketPatch, "version"> & { title: string; column?: string };
export type MoveTicket = { column: string; index?: number; version?: number };

export type BotSession = SessionView;
/** An agent key and its queue in one project. */
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
  project: { id: string; key: string; name: string; description: string };
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
export type OnboardingPage = { project: { key: string; name: string }; hasRepos: boolean; setup: SetupCommands };

/** The header search (WH-109): one result shape for every kind of thing it finds. */
export type SearchKind = "ticket" | "doc" | "node" | "decision" | "term";
export type SearchHit = {
  kind: SearchKind;
  id: string;
  projectKey: string;
  title: string;
  /** Plain text, never HTML; `marks` says which ranges to highlight. */
  snippet?: string;
  /** Highlight ranges [start, end) in `title`. */
  marks?: [start: number, end: number][];
  /** Highlight ranges [start, end) in `snippet`. */
  snippetMarks?: [start: number, end: number][];
  /** ref, column, priority, layer, number, status, updatedAt... */
  meta: Record<string, string | number | null>;
  href: string;
  score: number;
};
export type SearchGroup = { kind: SearchKind; total: number; hits: SearchHit[]; error?: string };
export type SearchResponse = { query: string; took: number; groups: SearchGroup[]; best: SearchHit[] };
