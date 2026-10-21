import type {
  Doc, DocDetail, DocsIndex, GithubStatus, OnboardingPage, Repository, AdminWorkspace, AdminWorkspaceDetail, AgentsPage, DashboardWidgets, KeyView, PendingInvite, TeamMembers, SetupCommands, WorkspaceOverview } from "@wheelhouse/api-client";

/** Believable answers from the page endpoints, for tests to start from and bend. */

export const SETUP: SetupCommands = {
  teamKey: "KEY",
  url: "https://wh.example.test",
  installPlugin: "/plugin marketplace add shipstackhq/wheelhouse-cli\n/plugin install wheelhouse@shipstack",
  marketplace: "shipstackhq/wheelhouse-cli",
  vscodeInstallLink: "vscode://anthropic.claude-code/install-plugin?plugin=wheelhouse&marketplace=shipstackhq/wheelhouse-cli",
  loginOptional: "npx @shipstack/wheelhouse-cli login --url https://wh.example.test",
  linkRepo: "/wheelhouse:setup KEY",
  buildMap: "/wheelhouse:map-codebase KEY\n/wheelhouse:map-schema KEY",
  refreshMap: "/wheelhouse:refresh-map KEY",
  mcpBuildMap: "/mcp__wheelhouse__map_codebase KEY\n/mcp__wheelhouse__map_schema KEY",
  mcpRefreshMap: "/mcp__wheelhouse__refresh_map KEY",
  cli: "npm install -g @shipstack/wheelhouse-cli\nwheelhouse login --url https://wh.example.test\nwheelhouse init --team KEY --url https://wh.example.test",
  mcp: "read -rs WHEELHOUSE_KEY; export WHEELHOUSE_KEY\nclaude mcp add --transport http wheelhouse https://wh.example.test/mcp --header \"Authorization: Bearer $WHEELHOUSE_KEY\"",
  rest: "curl -X POST https://wh.example.test/api/v1/create_issue \\\n  -H \"Authorization: Bearer $WHEELHOUSE_KEY\"",
};

export const key = (over: Partial<KeyView> = {}): KeyView => ({
  id: "k1",
  name: "Claude — Ada's laptop",
  prefix: "wh_abcdefg",
  createdAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  canWriteDocs: false,
  teams: [{ key: "AA", name: "Alpha" }],
  ...over,
});

export const agentsPage = (keys: KeyView[] = [key()], setup: Partial<SetupCommands> = {}): AgentsPage => ({ keys, setup: { ...SETUP, ...setup } });

export const invite = (over: Partial<PendingInvite> = {}): PendingInvite => ({
  id: "i1",
  kind: "join_workspace",
  email: "grace@example.test",
  role: "member",
  workspaceName: null,
  teams: [],
  createdAt: "2026-10-16T00:00:00.000Z",
  expiresAt: "2026-10-23T00:00:00.000Z",
  ...over,
});

export const workspace = (over: Partial<WorkspaceOverview> = {}): WorkspaceOverview => ({
  workspace: { id: "t1", name: "Analytical Engines" },
  role: "owner",
  members: [
    { userId: "u1", name: "Ada Lovelace", email: "ada@example.test", role: "owner", tags: ["eng"] },
    { userId: "u2", name: "Grace Hopper", email: "grace@example.test", role: "member", tags: ["backend", "lead"] },
  ],
  seats: { members: 2, pending: 0, used: 2, max: 5, full: false },
  pendingInvites: [],
  ...over,
});

export const adminWorkspace = (over: Partial<AdminWorkspace> = {}): AdminWorkspace => ({
  id: "t2",
  name: "Babbage & Co",
  createdAt: "2026-09-01T00:00:00.000Z",
  suspendedAt: null,
  suspendedReason: null,
  owners: [{ name: "Charles", email: "charles@example.test" }],
  members: 3,
  pendingInvites: 1,
  seatsUsed: 4,
  maxSeats: 5,
  teams: 2,
  lastActivity: null,
  invitedBy: { name: "Ada", email: "ada@example.test" },
  isYours: false,
  ...over,
});

export const adminWorkspaceDetail = (over: Partial<AdminWorkspaceDetail> = {}): AdminWorkspaceDetail => ({
  ...adminWorkspace(),
  suspendedBy: null,
  memberList: [{ userId: "u9", name: "Charles Babbage", email: "charles@example.test", role: "owner", tags: [], joinedAt: "2026-09-02T00:00:00.000Z" }],
  inviteList: [{ id: "i9", kind: "join_workspace", email: "new@example.test", role: "member", status: "pending", expiresAt: "2026-10-30T00:00:00.000Z", createdAt: "2026-10-16T00:00:00.000Z" }],
  keys: [{ id: "k9", name: "ci", prefix: "wh_zzzzzzz", createdAt: "2026-09-03T00:00:00.000Z", lastUsedAt: null, revokedAt: null }],
  ...over,
});

const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

export const widgets = (): DashboardWidgets => ({
  kpis: { teams: 2, open: 14, inProgress: 3, inReview: 2, completed7d: 5, completedPrev7d: 3, agentShare7d: 0.4, events7d: 20, staleNodes: 1, mapNodes: 12, staleDocs: 2, agents: 2, agentsActive7d: 1 },
  progress: [
    {
      id: "p1",
      key: "AA",
      name: "Alpha",
      total: 10,
      done: 4,
      pct: 0.4,
      stages: [
        { id: "c1", name: "Backlog", count: 2 },
        { id: "c2", name: "Todo", count: 2 },
        { id: "c3", name: "In Progress", count: 1 },
        { id: "c4", name: "Review", count: 1 },
        { id: "c5", name: "Done", count: 4 },
      ],
      urgent: 2,
      agentReady: 1,
      staleNodes: 1,
      mapNodes: 6,
      staleDocs: 1,
      lastActivity: new Date().toISOString(),
    },
  ],
  throughput: days(14).map((day, i) => ({ day, created: i % 3, completed: i % 2 })),
  "activity-split": days(14).map((day, i) => ({ day, human: i % 4, agent: i % 3 })),
  agents: [
    { id: "k1", name: "Claude — Ada's laptop", lastUsedAt: new Date().toISOString(), pending: 3, byTeam: [{ key: "AA", pending: 3 }], sessions: [], actions7d: 9 },
    { id: "k2", name: "CI bot", lastUsedAt: null, pending: 0, byTeam: [], sessions: [], actions7d: 0 },
  ],
  attention: {
    review: [{ ref: "AA-7", title: "Add the login page", teamKey: "AA", byAgent: true, updatedAt: new Date().toISOString() }],
    urgent: [{ ref: "AA-9", title: "Fix the crash", teamKey: "AA", status: "In Progress" }],
    stale: [{ id: "n1", name: "Service layer", layer: "system", reason: "src/lib/service.ts changed", teamKey: "AA" }],
    staleDocs: [{ id: "d1", slug: "runbook", title: "Runbook", reason: "code changed", teamKey: "AA" }],
  },
  recent: [
    { seq: 3, teamKey: "AA", actorKind: "agent", actorName: "Claude — Ada's laptop", summary: "moved AA-7 from In Progress → Review", createdAt: new Date().toISOString() },
    { seq: 2, teamKey: "AA", actorKind: "human", actorName: "Ada Lovelace", summary: "created AA-9", createdAt: new Date().toISOString() },
  ],
  sync: { untracked: [], quiet: [{ ref: "AA-4", title: "Refactor auth", teamKey: "AA", agent: "CI bot", lastAt: new Date(Date.now() - 3 * 3600e3).toISOString() }], drafts: [] },
  focus: {
    aging: [{ ref: "AA-4", title: "Refactor auth", status: "In Progress", priority: "high", days: 9, byAgent: true }],
    waitingReview: [{ ref: "AA-6", title: "Add rate limiting", status: "Review", priority: "medium", days: 4, byAgent: false }],
    quiet: [{ ref: "AA-4", title: "Refactor auth", teamKey: "AA", agent: "CI bot", lastAt: new Date(Date.now() - 3 * 3600e3).toISOString() }],
    proposedDecisions: 2,
    members: { count: 3, myRole: "admin" },
    issues: 12,
  },
});

/** The dashboard's endpoints, all answering from `data`. */
export const serveWidgets = (server: { on: (route: string, answer: unknown) => unknown }, data = widgets()) => {
  for (const [name, value] of Object.entries(data)) server.on(`GET /api/app/dashboard/${name}`, value);
};

// ───────── the board ─────────

import type { BoardIssue, BoardView, Bot, CycleDetail, CycleSummary, InitiativeDetail, InitiativeSummary, ProjectDetail, ProjectSummary, IssueDetail, StatusRole, StatusSetting } from "@wheelhouse/api-client";

export const STATUSES = [
  { id: "c-backlog", name: "Backlog", role: "backlog", isDefault: true, color: null, position: 1000 },
  { id: "c-todo", name: "Todo", role: "todo", isDefault: true, color: null, position: 2000 },
  { id: "c-progress", name: "In Progress", role: "in_progress", isDefault: true, color: null, position: 3000 },
  { id: "c-review", name: "Review", role: "review", isDefault: true, color: null, position: 4000 },
  { id: "c-done", name: "Done", role: "done", isDefault: true, color: null, position: 5000 },
  { id: "c-canceled", name: "Canceled", role: "canceled", isDefault: true, color: null, position: 6000 },
];

/** What the team settings list: the board's statuses with how many issues are in each (the board's issues are in Backlog and Todo). */
export const statusSettings = (over: Partial<StatusSetting>[] | ((all: StatusSetting[]) => StatusSetting[]) = []): StatusSetting[] => {
  const all: StatusSetting[] = STATUSES.map((s) => ({ ...s, role: s.role as StatusRole, issueCount: { "c-backlog": 1, "c-todo": 2 }[s.id] ?? 0 }));
  return typeof over === "function" ? over(all) : all.map((s, i) => ({ ...s, ...(over[i] ?? {}) }));
};

let seq = 0;
export const issue = (over: Partial<BoardIssue> = {}): BoardIssue => {
  const n = over.number ?? ++seq + 100;
  return {
    id: `t-${n}`,
    ref: `AA-${n}`,
    number: n,
    title: `Issue ${n}`,
    body: "",
    statusId: "c-backlog",
    priority: "none",
    assigneeId: null,
    agentClaimable: false,
    claimedByKeyId: null,
    labels: [],
    cycle: null,
    projectId: null,
    parentId: null,
    milestoneId: null,
    position: n * 1000,
    version: 1,
    createdByKind: "human",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    nodeIds: [],
    commentCount: 0,
    ...over,
  };
};

export const board = (key = "AA", over: Partial<BoardView> = {}): BoardView => ({
  team: { id: `id-${key}`, key, name: key === "AA" ? "Alpha" : "Beta", description: "" },
  statuses: STATUSES,
  issues: [
    issue({ number: 1, title: "Write the plan", statusId: "c-backlog", priority: "high", labels: ["docs"] }),
    issue({ number: 2, title: "Build the board", statusId: "c-todo", agentClaimable: true }),
    issue({ number: 3, title: "Fix the crash", statusId: "c-todo", priority: "medium", createdByKind: "agent", commentCount: 2 }),
    issue({ number: 4, title: "Ship it", statusId: "c-done" }),
  ],
  nodes: [
    { id: "n-api", name: "API", kind: "service", parentId: null, layer: "system" },
    { id: "n-board", name: "Board UI", kind: "component", parentId: "n-api", layer: "system" },
  ],
  members: [
    { id: "u1", name: "Ada Lovelace" },
    { id: "u2", name: "Grace Hopper" },
  ],
  cycles: [],
  projects: [],
  checklist: {
    items: [
      { id: "repos", label: "Repositories", done: true, status: "GitHub connected", href: `/t/${key}/repos` },
      { id: "machines", label: "Machines", done: true, status: "linked", href: `/t/${key}` },
      { id: "agents", label: "Agents", done: true, status: "1 key", href: "/agents" },
      { id: "map", label: "Map", done: true, status: "built", href: `/t/${key}/map` },
      { id: "teammates", label: "Teammates", done: true, status: "invited", href: "/workspace" },
    ],
    done: true,
    doneCount: 5,
    total: 5,
  },
  ...over,
});

export const detail = (t: BoardIssue, over: Partial<IssueDetail> = {}): IssueDetail => ({
  issue: { ...t, status: STATUSES.find((c) => c.id === t.statusId)?.name },
  team: { key: "AA", name: "Alpha" },
  comments: [],
  nodes: [],
  history: [{ seq: 1, actorKind: "human", actorName: "Ada Lovelace", summary: `created ${t.ref} "${t.title}" in Backlog`, createdAt: "2026-10-10T00:00:00.000Z" }],
  pullRequests: [],
  parent: null,
  children: [],
  ...over,
});

export const bot = (over: Partial<Bot> = {}): Bot => ({ id: "k1", name: "Claude — Ada's laptop", pending: 0, lastUsedAt: null, sessions: [], ...over });

// ───────── the map ─────────

import type { Flow, GraphView, MapEdge, MapNode, Decision, Term } from "@wheelhouse/api-client";

export const mapNode = (over: Partial<MapNode> & Pick<MapNode, "id" | "name" | "layer">): MapNode => ({
  parentId: null,
  kind: over.layer === "concept" ? "concept" : over.layer === "data" ? "table" : over.layer === "code" ? "directory" : "service",
  summary: "",
  purpose: "",
  responsibilities: "",
  interfaces: "",
  gotchas: "",
  details: "",
  anchors: [],
  columns: [],
  indexes: [],
  describedSha: null,
  describedAt: "2026-10-10T00:00:00.000Z",
  stale: false,
  staleReason: null,
  status: "live",
  x: 0,
  y: 0,
  width: null,
  height: null,
  placed: true,
  version: 1,
  ...over,
});

export const MAP_NODES: MapNode[] = [
  mapNode({ id: "c-bill", name: "Billing", layer: "concept", summary: "Takes the money", purpose: "Why we charge", x: 60, y: 60 }),
  mapNode({ id: "s-api", name: "API", layer: "system", summary: "The HTTP API", purpose: "Serves every client", anchors: ["apps/api/**"], x: 60, y: 60, width: 520, height: 260 }),
  mapNode({ id: "s-auth", name: "Auth", layer: "system", kind: "module", parentId: "s-api", summary: "Who is calling", x: 20, y: 70 }),
  mapNode({ id: "s-pay", name: "Payments", layer: "system", kind: "module", parentId: "s-api", summary: "Charges cards", x: 250, y: 70, stale: true, staleReason: "src/pay/charge.ts changed in abc1234" }),
  mapNode({ id: "s-web", name: "Web", layer: "system", summary: "The app", x: 700, y: 60 }),
  mapNode({
    id: "d-users",
    name: "users",
    layer: "data",
    summary: "People",
    x: 400,
    y: 60,
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "email", type: "text", unique: true },
    ],
  }),
  mapNode({
    id: "d-posts",
    name: "posts",
    layer: "data",
    x: 60,
    y: 60,
    columns: [
      { name: "id", type: "uuid", pk: true },
      { name: "author_id", type: "uuid", references: "users.id", onDelete: "cascade" },
    ],
  }),
  mapNode({ id: "k-pay", name: "src/pay", layer: "code", kind: "directory", anchors: ["src/pay/**"], x: 60, y: 60 }),
];

export const MAP_EDGES: MapEdge[] = [
  { id: "e1", kind: "depends", fromNodeId: "s-web", toNodeId: "s-api", label: "REST", meta: {} },
  { id: "e2", kind: "implements", fromNodeId: "s-pay", toNodeId: "c-bill", label: "", meta: {} },
  { id: "e3", kind: "references", fromNodeId: "d-posts", toNodeId: "d-users", label: "author_id → id", meta: { fromColumn: "author_id", toColumn: "id", cardinality: "n-1", derived: true, onDelete: "cascade" } },
];

export const MAP_FLOWS: Flow[] = [
  { id: "f1", name: "Sign in", description: "How a person gets in", version: 2, steps: [
    { nodeId: "s-web", title: "Open the page", detail: "The **app** loads" },
    { nodeId: "s-auth", title: "Check the password", detail: "" },
  ] },
];

export const MAP_DECISIONS: Decision[] = [
  { id: "dec1", number: 1, title: "Use REST", status: "accepted", context: "We needed one protocol", decision: "REST over HTTP", consequences: "No streaming", nodeIds: ["s-api"], authorKind: "human", authorName: "Ada Lovelace", version: 1, updatedAt: "2026-10-12T00:00:00.000Z" },
  { id: "dec2", number: 2, title: "Drop GraphQL", status: "rejected", context: "", decision: "Not now", consequences: "", nodeIds: [], authorKind: "agent", authorName: "Claude", version: 3, updatedAt: "2026-10-13T00:00:00.000Z" },
];

export const MAP_TERMS: Term[] = [
  { id: "t1", term: "Invoice", definition: "A bill we send", nodeId: "c-bill" },
  { id: "t2", term: "Tenant", definition: "One customer's workspace", nodeId: null },
];

export const graph = (key = "AA", over: Partial<GraphView> = {}): GraphView => ({
  team: { id: `id-${key}`, key, name: key === "AA" ? "Alpha" : "Beta", description: "" },
  nodes: MAP_NODES,
  edges: MAP_EDGES,
  issueLinks: [{ nodeId: "s-api", issueId: "t-1", number: 1, title: "Write the plan", statusId: "c-backlog", ref: `${key}-1` }],
  flows: MAP_FLOWS,
  decisions: MAP_DECISIONS,
  terms: MAP_TERMS,
  flux: {
    "s-auth": {
      sessions: [{ id: "sess-1", by: "Claude — Ada's laptop", issue: `${key}-9`, files: ["apps/api/src/auth.ts", "apps/api/src/session.ts"] }],
      drafts: [{ id: "draft-1", authorKind: "agent", authorName: "Claude — Ada's laptop", confirm: false, patch: { purpose: "Checks passwords and sessions" } }],
    },
  },
  askEnabled: true,
  ...over,
});

export const activityEvent = (over: Partial<import("@wheelhouse/api-client").ActivityEvent2> = {}): import("@wheelhouse/api-client").ActivityEvent2 => ({
  seq: 1,
  actorKind: "human",
  actorName: "Ada Lovelace",
  type: "issue.created",
  entity: "issue",
  entityId: "t-1",
  summary: 'created AA-1 "Write the plan" in Backlog',
  data: { ref: "AA-1" },
  createdAt: new Date().toISOString(),
  ...over,
});

// ───────── docs, repositories, onboarding (WH-98) ─────────

export const doc = (over: Partial<Doc> = {}): Doc => ({
  id: "d-plan",
  parentId: null,
  slug: "plan",
  title: "Plan",
  version: 1,
  position: 1,
  updatedAt: "2026-10-16T00:00:00.000Z",
  stale: false,
  body: "# Plan\n\nWe ship **soon**.",
  anchors: [],
  labels: [],
  staleReason: null,
  updatedByKind: "human",
  updatedById: "u1",
  createdAt: "2026-10-10T00:00:00.000Z",
  ...over,
});

const treeItem = ({ id, parentId, slug, title, version, position, updatedAt, stale }: Doc) => ({ id, parentId, slug, title, version, position, updatedAt, stale });

export const DOCS: Doc[] = [
  doc(),
  doc({ id: "d-api", slug: "api", title: "API notes", position: 2, body: "Talks to `src/lib/service.ts`.", anchors: ["src/lib/**"], stale: true, staleReason: "src/lib/service.ts changed in abc1234" }),
  doc({ id: "d-sub", parentId: "d-plan", slug: "plan/phase-1", title: "Phase 1", position: 1, body: "Phase one." }),
];

export const docsIndex = (docs: Doc[] = DOCS, over: Partial<DocsIndex> = {}): DocsIndex => ({
  docs: docs.map(treeItem),
  nodes: [
    { id: "s-api", name: "API", layer: "system", parentId: null },
    { id: "c-bill", name: "Billing", layer: "concept", parentId: null },
  ],
  decisions: [{ id: "dec1", number: 1, title: "Use REST" }],
  members: [{ id: "u1", name: "Ada Lovelace" }],
  ...over,
});

export const docDetail = (d: Doc, nodes: DocDetail["nodes"] = [], people: Partial<Pick<DocDetail, "owner" | "contributors">> = {}): DocDetail => ({
  doc: d,
  nodes,
  owner: { kind: "human", id: "u1", name: "Ada Lovelace" },
  contributors: [],
  ...people,
});

export const repo = (over: Partial<Repository> = {}): Repository => ({
  id: "r1",
  displayName: "Backend",
  role: "backend",
  provider: "local",
  slug: "backend",
  githubFullName: null,
  defaultBranch: "main",
  pathLimit: null,
  lifecycle: "live",
  lastEventAt: null,
  browsable: false,
  ...over,
});

export const githubStatus = (over: Partial<GithubStatus> = {}): GithubStatus => ({
  configured: true,
  missing: [],
  isOwner: true,
  installations: [{ installationId: "1001", account: "acme", failed: false, repositories: [{ id: "5001", fullName: "acme/web", private: false }, { id: "5002", fullName: "acme/api", private: true }] }],
  ...over,
});

export const onboardingPage = (key = "AA", over: Partial<OnboardingPage> = {}): OnboardingPage => ({
  team: { key, name: key === "AA" ? "Alpha" : "Beta" },
  hasRepos: false,
  setup: { ...SETUP, teamKey: key, linkRepo: `/wheelhouse:setup ${key}`, buildMap: `/wheelhouse:map-codebase ${key}\n/wheelhouse:map-schema ${key}` },
  ...over,
});

/** Who is in team AA: Ada (workspace owner, team admin), Grace (editor) and Alan (workspace member, team viewer). */
export const teamMembers = (over: Partial<TeamMembers> = {}): TeamMembers => ({
  team: { id: "p1", key: "AA", name: "Analytical Engine" },
  myRole: "admin",
  members: [
    { userId: "u1", name: "Ada Lovelace", email: "ada@example.test", role: "admin", workspaceRole: "owner", addedAt: "2026-10-01T00:00:00.000Z" },
    { userId: "u2", name: "Grace Hopper", email: "grace@example.test", role: "editor", workspaceRole: "member", addedAt: "2026-10-02T00:00:00.000Z" },
    { userId: "u3", name: "Alan Turing", email: "alan@example.test", role: "viewer", workspaceRole: "member", addedAt: "2026-10-03T00:00:00.000Z" },
  ],
  ...over,
});

// ───────── cycles ─────────

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

export const cycleSummary = (over: Partial<CycleSummary> = {}): CycleSummary => ({
  number: 1,
  name: "",
  goal: "",
  startsAt: inDays(-2),
  endsAt: inDays(5),
  state: "current",
  total: 0,
  done: 0,
  open: 0,
  ...over,
});

export const cycleDetail = (over: Partial<CycleDetail> = {}): CycleDetail => ({ ...cycleSummary(), issues: [], landed: [], ...over });

// ───────── projects ─────────

export const projectSummary = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: "p1",
  name: "Launch SSO",
  description: "",
  status: "active",
  health: { derived: "on_track", override: null, value: "on_track" },
  startDate: "2026-11-01",
  targetDate: "2026-12-15",
  leadUser: { id: "u1", name: "Ada Lovelace" },
  leadTeam: { key: "AA", name: "Alpha" },
  total: 0,
  done: 0,
  teamCount: 1,
  version: 1,
  canEdit: true,
  updatedAt: "2026-10-20T00:00:00.000Z",
  ...over,
});

export const projectDetail = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  ...projectSummary(),
  canAdmin: true,
  milestones: [],
  teams: [{ key: "AA", name: "Alpha", role: "admin", lead: true, total: 0, done: 0, issues: [] }],
  others: { count: 0, total: 0, done: 0 },
  addableTeams: [],
  ...over,
});

// ───────── initiatives ─────────

export const initiativeSummary = (over: Partial<InitiativeSummary> = {}): InitiativeSummary => ({
  id: "i1",
  parentId: null,
  name: "Enterprise ready",
  description: "",
  status: "active",
  health: { derived: "on_track", override: null, value: "on_track" },
  targetDate: "2026-12-31",
  owner: { id: "u1", name: "Ada Lovelace" },
  total: 0,
  done: 0,
  projectCount: 0,
  childCount: 0,
  depth: 1,
  version: 1,
  canEdit: true,
  updatedAt: "2026-10-20T00:00:00.000Z",
  ...over,
});

export const initiativeDetail = (over: Partial<InitiativeDetail> = {}): InitiativeDetail => ({
  ...initiativeSummary(),
  path: [],
  children: [],
  projects: [],
  hidden: { count: 0, total: 0, done: 0 },
  linkable: [],
  ...over,
});
