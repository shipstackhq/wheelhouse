import type { AdminTeam, AdminTeamDetail, AgentsPage, DashboardWidgets, KeyView, PendingInvite, SetupCommands, TeamOverview } from "@wheelhouse/api-client";

/** Believable answers from the page endpoints, for tests to start from and bend. */

export const SETUP: SetupCommands = {
  projectKey: "KEY",
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
  cli: "npm install -g @shipstack/wheelhouse-cli\nwheelhouse login --url https://wh.example.test\nwheelhouse init --project KEY --url https://wh.example.test",
  mcp: "read -rs WHEELHOUSE_KEY; export WHEELHOUSE_KEY\nclaude mcp add --transport http wheelhouse https://wh.example.test/mcp --header \"Authorization: Bearer $WHEELHOUSE_KEY\"",
  rest: "curl -X POST https://wh.example.test/api/v1/create_ticket \\\n  -H \"Authorization: Bearer $WHEELHOUSE_KEY\"",
};

export const key = (over: Partial<KeyView> = {}): KeyView => ({
  id: "k1",
  name: "Claude — Ada's laptop",
  prefix: "wh_abcdefg",
  createdAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  canWriteDocs: false,
  ...over,
});

export const agentsPage = (keys: KeyView[] = [key()], setup: Partial<SetupCommands> = {}): AgentsPage => ({ keys, setup: { ...SETUP, ...setup } });

export const invite = (over: Partial<PendingInvite> = {}): PendingInvite => ({
  id: "i1",
  kind: "join_team",
  email: "grace@example.test",
  role: "member",
  teamName: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  expiresAt: "2026-10-23T00:00:00.000Z",
  ...over,
});

export const team = (over: Partial<TeamOverview> = {}): TeamOverview => ({
  team: { id: "t1", name: "Analytical Engines" },
  role: "owner",
  members: [
    { userId: "u1", name: "Ada Lovelace", email: "ada@example.test", role: "owner", tags: ["eng"] },
    { userId: "u2", name: "Grace Hopper", email: "grace@example.test", role: "member", tags: ["backend", "lead"] },
  ],
  seats: { members: 2, pending: 0, used: 2, max: 5, full: false },
  pendingInvites: [],
  ...over,
});

export const adminTeam = (over: Partial<AdminTeam> = {}): AdminTeam => ({
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
  projects: 2,
  lastActivity: null,
  invitedBy: { name: "Ada", email: "ada@example.test" },
  isYours: false,
  ...over,
});

export const adminTeamDetail = (over: Partial<AdminTeamDetail> = {}): AdminTeamDetail => ({
  ...adminTeam(),
  suspendedBy: null,
  memberList: [{ userId: "u9", name: "Charles Babbage", email: "charles@example.test", role: "owner", tags: [], joinedAt: "2026-09-02T00:00:00.000Z" }],
  inviteList: [{ id: "i9", kind: "join_team", email: "new@example.test", role: "member", status: "pending", expiresAt: "2026-10-30T00:00:00.000Z", createdAt: "2026-10-16T00:00:00.000Z" }],
  keys: [{ id: "k9", name: "ci", prefix: "wh_zzzzzzz", createdAt: "2026-09-03T00:00:00.000Z", lastUsedAt: null, revokedAt: null }],
  ...over,
});

const days = (n: number) => Array.from({ length: n }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

export const widgets = (): DashboardWidgets => ({
  kpis: { projects: 2, open: 14, inProgress: 3, inReview: 2, completed7d: 5, completedPrev7d: 3, agentShare7d: 0.4, events7d: 20, staleNodes: 1, mapNodes: 12, staleDocs: 2, agents: 2 },
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
    { id: "k1", name: "Claude — Ada's laptop", lastUsedAt: new Date().toISOString(), pending: 3, byProject: [{ key: "AA", pending: 3 }], sessions: [], actions7d: 9 },
    { id: "k2", name: "CI bot", lastUsedAt: null, pending: 0, byProject: [], sessions: [], actions7d: 0 },
  ],
  attention: {
    review: [{ ref: "AA-7", title: "Add the login page", projectKey: "AA", byAgent: true, updatedAt: new Date().toISOString() }],
    urgent: [{ ref: "AA-9", title: "Fix the crash", projectKey: "AA", column: "In Progress" }],
    stale: [{ id: "n1", name: "Service layer", layer: "system", reason: "src/lib/service.ts changed", projectKey: "AA" }],
    staleDocs: [{ id: "d1", slug: "runbook", title: "Runbook", reason: "code changed", projectKey: "AA" }],
  },
  recent: [
    { seq: 3, projectKey: "AA", actorKind: "agent", actorName: "Claude — Ada's laptop", summary: "moved AA-7 from In Progress → Review", createdAt: new Date().toISOString() },
    { seq: 2, projectKey: "AA", actorKind: "human", actorName: "Ada Lovelace", summary: "created AA-9", createdAt: new Date().toISOString() },
  ],
  sync: { untracked: [], quiet: [{ ref: "AA-4", title: "Refactor auth", projectKey: "AA", agent: "CI bot", lastAt: new Date(Date.now() - 3 * 3600e3).toISOString() }], drafts: [] },
});

/** The dashboard's endpoints, all answering from `data`. */
export const serveWidgets = (server: { on: (route: string, answer: unknown) => unknown }, data = widgets()) => {
  for (const [name, value] of Object.entries(data)) server.on(`GET /api/app/dashboard/${name}`, value);
};

// ───────── the board ─────────

import type { BoardTicket, BoardView, Bot, TicketDetail } from "@wheelhouse/api-client";

export const COLUMNS = [
  { id: "c-backlog", name: "Backlog", role: "backlog", position: 1000 },
  { id: "c-todo", name: "Todo", role: "todo", position: 2000 },
  { id: "c-progress", name: "In Progress", role: "in_progress", position: 3000 },
  { id: "c-review", name: "Review", role: "review", position: 4000 },
  { id: "c-done", name: "Done", role: "done", position: 5000 },
];

let seq = 0;
export const ticket = (over: Partial<BoardTicket> = {}): BoardTicket => {
  const n = over.number ?? ++seq + 100;
  return {
    id: `t-${n}`,
    ref: `AA-${n}`,
    number: n,
    title: `Ticket ${n}`,
    body: "",
    columnId: "c-backlog",
    priority: "medium",
    assigneeId: null,
    agentClaimable: false,
    claimedByKeyId: null,
    labels: [],
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
  project: { id: `id-${key}`, key, name: key === "AA" ? "Alpha" : "Beta", description: "" },
  columns: COLUMNS,
  tickets: [
    ticket({ number: 1, title: "Write the plan", columnId: "c-backlog", priority: "high", labels: ["docs"] }),
    ticket({ number: 2, title: "Build the board", columnId: "c-todo", agentClaimable: true }),
    ticket({ number: 3, title: "Fix the crash", columnId: "c-todo", createdByKind: "agent", commentCount: 2 }),
    ticket({ number: 4, title: "Ship it", columnId: "c-done" }),
  ],
  nodes: [
    { id: "n-api", name: "API", kind: "service", parentId: null, layer: "system" },
    { id: "n-board", name: "Board UI", kind: "component", parentId: "n-api", layer: "system" },
  ],
  members: [
    { id: "u1", name: "Ada Lovelace" },
    { id: "u2", name: "Grace Hopper" },
  ],
  checklist: {
    items: [
      { id: "repos", label: "Repositories", done: true, status: "GitHub connected", href: `/p/${key}/repos` },
      { id: "machines", label: "Machines", done: true, status: "linked", href: `/p/${key}` },
      { id: "agents", label: "Agents", done: true, status: "1 key", href: "/agents" },
      { id: "map", label: "Map", done: true, status: "built", href: `/p/${key}/map` },
      { id: "teammates", label: "Teammates", done: true, status: "invited", href: "/team" },
    ],
    done: true,
    doneCount: 5,
    total: 5,
  },
  ...over,
});

export const detail = (t: BoardTicket, over: Partial<TicketDetail> = {}): TicketDetail => ({
  ticket: { ...t, column: COLUMNS.find((c) => c.id === t.columnId)?.name },
  project: { key: "AA", name: "Alpha" },
  comments: [],
  nodes: [],
  history: [{ seq: 1, actorKind: "human", actorName: "Ada Lovelace", summary: `created ${t.ref} "${t.title}" in Backlog`, createdAt: "2026-10-10T00:00:00.000Z" }],
  pullRequests: [],
  ...over,
});

export const bot = (over: Partial<Bot> = {}): Bot => ({ id: "k1", name: "Claude — Ada's laptop", pending: 0, lastUsedAt: null, sessions: [], ...over });
