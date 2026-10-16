/** The shapes the web app's API answers with (JSON: every date is an ISO string). Kept by hand and checked by the contract suite. */

export type Role = "owner" | "member";

// ───────── team, members, keys, invites ─────────

export type TeamMember = { userId: string; name: string; email: string; role: Role; tags: string[] };
export type Seats = { members: number; pending: number; used: number; max: number; full: boolean };

export type PendingInvite = {
  id: string;
  kind: "new_team" | "join_team";
  email: string;
  role: Role;
  teamName: string | null;
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

export type CreateInviteInput = { kind: "join_team" | "new_team"; email: string; role?: Role; tags?: string[] | string; team?: string };
export type CreatedInvite = { id: string; email: string; kind: "new_team" | "join_team"; expiresAt: string; link: string };
export type InvitePeek = { email: string; kind: "new_team" | "join_team"; teamName: string | null };
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
};
