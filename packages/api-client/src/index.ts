/**
 * A typed client for the web app's API (/api/app, WH-93). Only `fetch`, so it runs in the browser and in tests.
 *
 *   const api = createApiClient();                       // same origin, as the React app is served
 *   const me = await api.me();                           // null when signed out
 *   await api.auth.login({ email, password });
 *   const teams = await api.teams.list();
 *
 * It does two things every caller would otherwise get wrong:
 *  - the CSRF token: sent as X-CSRF-Token on every state-changing request ("anonymous" before sign-in; the token from
 *    /me, sign-in or sign-up after), and refreshed once, transparently, if the server says it has gone stale;
 *  - errors: every failure becomes an ApiError with the status, the machine-readable `code`, a human `message`, field
 *    problems in `fields`, and for an optimistic-lock conflict the server's current copy in `current`.
 * The conventions behind it are in docs/ui-api.md.
 */

import type {
  ActivityEvent2,
  AddableMember,
  InvitePeekExisting,
  WorkspaceChoice,
  AuditEvent,
  TeamMembers,
  TeamRole,
  WorkspaceTeam,
  AskAnswer,
  Decision,
  DecisionInput,
  Flow,
  FlowInput,
  GraphView,
  MapEdge,
  MapNode,
  NodePatch,
  NodePosition,
  Term,
  AcceptInviteInput,
  AdminWorkspace,
  AdminWorkspaceDetail,
  AgentsPage,
  BoardView,
  Bot,
  CreatedInvite,
  Doc,
  DocDetail,
  DocPatch,
  DocsIndex,
  GithubStatus,
  NewDoc,
  OnboardingPage,
  Repository,
  RepositoryInput,
  CreatedKey,
  CycleDetail,
  CycleInput,
  CycleList,
  NewStatus,
  StatusPatch,
  StatusSetting,
  CycleSummary,
  CreateInviteInput,
  DashboardWidgets,
  InvitePeek,
  KeyView,
  MilestoneInput,
  MoveIssue,
  NewIssue,
  PendingInvite,
  ProjectDetail,
  ProjectInput,
  ProjectSummary,
  InitiativeDetail,
  InitiativeInput,
  InitiativeSummary,
  Role,
  WorkspaceMember,
  WorkspaceOverview,
  IssueComment,
  IssueDetail,
  IssuePatch,
  IssueView,
  DeviceView,
  IssueRuns,
  JobEvent,
  JobView,
  PairingPeek,
  RunBranches,
} from "./types";

export type * from "./types";

export type Me = {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string };
  role: Role;
  /** The person's labels within the workspace (for example "eng"). */
  tags: string[];
  isInstanceAdmin: boolean;
  /** Sent back as X-CSRF-Token on state-changing requests; the client does this for you. */
  csrfToken: string;
};

export type Team = { id: string; key: string; name: string; description: string; createdAt: string; /** `ri:<name>` (a Remix icon, drawn in `iconColor`) or one emoji; null for the default. */ icon: string | null; iconColor: string | null; /** The caller's own role in it. */ role?: TeamRole };
export type CreateTeamInput = { name: string; key?: string; description?: string };

export type LoginInput = { email: string; password: string };
export type SignupInput = { name: string; email: string; password: string; workspace?: string };

/** Every failed request. `code` is stable and meant for code; `message` is meant for people. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Seconds to wait, from Retry-After (rate limits). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** Problems with particular inputs, by field name, when the server found some. */
  get fields(): Record<string, string> | undefined {
    const f = (this.details as { fields?: unknown } | undefined)?.fields;
    return f && typeof f === "object" ? (f as Record<string, string>) : undefined;
  }
  /** On an optimistic-lock conflict (code "conflict"), what the server has now. */
  get current(): unknown {
    return (this.details as { current?: unknown } | undefined)?.current;
  }
  get isConflict() {
    return this.code === "conflict";
  }
  get isSignedOut() {
    return this.status === 401 && this.code === "unauthorized";
  }
}

export type ApiClientOptions = {
  /** Prefix for every path; empty for same-origin. */
  baseUrl?: string;
  /** Replace fetch, e.g. to add a cookie jar in tests. */
  fetch?: typeof fetch;
};

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ANONYMOUS = "anonymous";

export function createApiClient(options: ApiClientOptions = {}) {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let csrf = ANONYMOUS;

  const team = (key: string) => `/api/app/teams/${encodeURIComponent(key)}`;

  async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const m = method.toUpperCase();
    const unsafe = UNSAFE.has(m);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (unsafe) headers["x-csrf-token"] = csrf;
    const res = await doFetch(base + path, { method: m, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) return json as T;

    const env = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    const retryAfter = Number(res.headers.get("retry-after"));
    const err = new ApiError(res.status, env?.code ?? "http_error", env?.message ?? (text.slice(0, 200) || res.statusText || `Request failed (${res.status})`), env?.details, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    // A stale token (signed in or out elsewhere) is fixed once, invisibly. Never loop.
    if (err.code === "csrf_failed" && unsafe && !retried) {
      await refreshToken();
      return request<T>(method, path, body, true);
    }
    throw err;
  }

  async function refreshToken() {
    try {
      csrf = (await request<Me>("GET", "/api/app/me")).csrfToken;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) csrf = ANONYMOUS;
      else throw e;
    }
  }

  const adopt = (me: Me) => {
    csrf = me.csrfToken;
    return me;
  };

  return {
    /** Any endpoint, with the same CSRF and error handling. Use the named methods where there is one. */
    request,
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
    delete: <T>(path: string) => request<T>("DELETE", path),

    /** The signed-in person, or null when signed out. */
    async me(): Promise<Me | null> {
      try {
        return adopt(await request<Me>("GET", "/api/app/me"));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          csrf = ANONYMOUS;
          return null;
        }
        throw e;
      }
    },

    auth: {
      /** For a signed-out page: may it offer sign-up? */
      options: () => request<{ signupOpen: boolean }>("GET", "/api/app/auth/options"),
      login: async (input: LoginInput) => adopt(await request<Me>("POST", "/api/app/auth/login", input)),
      signup: async (input: SignupInput) => adopt(await request<Me>("POST", "/api/app/auth/signup", input)),
      logout: async () => {
        await request<{ ok: true }>("POST", "/api/app/auth/logout", {});
        csrf = ANONYMOUS;
      },
    },

    /** The person's workspaces, and moving this session to another. After a switch every cached read belongs to the old one. */
    workspaces: {
      list: async () => (await request<{ workspaces: WorkspaceChoice[] }>("GET", "/api/app/me/workspaces")).workspaces,
      switchTo: async (workspaceId: string) => (await request<{ workspace: { id: string; name: string } }>("POST", "/api/app/me/workspace", { workspaceId })).workspace,
    },

    /** Workspace-level views of access (owners and admins). */
    access: {
      teams: async () => (await request<{ teams: WorkspaceTeam[] }>("GET", "/api/app/access/teams")).teams,
      audit: async (opts: { team?: string; limit?: number } = {}) => {
        const q = new URLSearchParams();
        if (opts.team) q.set("team", opts.team);
        if (opts.limit) q.set("limit", String(opts.limit));
        return (await request<{ events: AuditEvent[] }>("GET", `/api/app/access/audit${q.size ? `?${q}` : ""}`)).events;
      },
    },

    teams: {
      list: async () => (await request<{ teams: Team[] }>("GET", "/api/app/teams")).teams,
      /** Keep the teams in this order (keys, first to last) for this person; `list` then returns them so. */
      reorder: (keys: string[]) => request<{ ok: true; placed: number }>("PUT", "/api/app/teams/order", { keys }),
      create: async (input: CreateTeamInput) => (await request<{ team: Team }>("POST", "/api/app/teams", input)).team,
      /** Team settings: rename it, change its description, icon or icon colour (team admins). `null` clears an icon. */
      update: async (teamKey: string, input: { name?: string; description?: string; icon?: string | null; iconColor?: string | null }) =>
        (await request<{ team: Team }>("PATCH", `/api/app/teams/${encodeURIComponent(teamKey)}`, input)).team,
      /** The team page in one read: statuses, issues, map nodes, members and the setup checklist. */
      board: (teamKey: string) => request<BoardView>("GET", `/api/app/teams/${encodeURIComponent(teamKey)}/board`),
      /** The Bots menu: each agent key with its queue in this team. */
      queue: async (teamKey: string) => (await request<{ bots: Bot[] }>("GET", `/api/app/teams/${encodeURIComponent(teamKey)}/queue`)).bots,
      /** Who is in the team, and the caller's own role in it. */
      members: (teamKey: string) => request<TeamMembers>("GET", `${team(teamKey)}/members`),
      /** Workspace members who could still be added (team admins). */
      addableMembers: async (teamKey: string) => (await request<{ people: AddableMember[] }>("GET", `${team(teamKey)}/members/addable`)).people,
      addMember: (teamKey: string, input: { userId: string; role: TeamRole }) => request<{ member: { userId: string; role: TeamRole } }>("POST", `${team(teamKey)}/members`, input),
      setMemberRole: (teamKey: string, userId: string, role: TeamRole) =>
        request<{ member: { userId: string; role: TeamRole } }>("PATCH", `${team(teamKey)}/members/${encodeURIComponent(userId)}`, { role }),
      /** Remove someone from the team, or leave it yourself. */
      removeMember: (teamKey: string, userId: string) => request<{ ok: true }>("DELETE", `${team(teamKey)}/members/${encodeURIComponent(userId)}`),
      /** A workspace owner or admin joins the team as its admin (audited). */
      join: (teamKey: string) => request<{ team: { id: string; key: string; name: string } }>("POST", `${team(teamKey)}/join`, {}),
      /** Teammates remove an agent session from a team. */
      removeSession: (teamKey: string, sessionId: string) =>
        request<{ ok: true }>("DELETE", `/api/app/teams/${encodeURIComponent(teamKey)}/sessions/${encodeURIComponent(sessionId)}`),
    },

    statuses: {
      /** The team's statuses in board order, each with its role, whether it is its role's default, its colour and its issue count. */
      list: async (teamKey: string) => (await request<{ statuses: StatusSetting[] }>("GET", `${team(teamKey)}/statuses`)).statuses,
      /** A new status at the end of its role's group (team admins). The first of a role is its default. */
      create: async (teamKey: string, input: NewStatus) => (await request<{ status: StatusSetting }>("POST", `${team(teamKey)}/statuses`, input)).status,
      /** Rename, recolour or make default (team admins). A role cannot change. `status` is an id or a name. */
      update: async (teamKey: string, status: string, patch: StatusPatch) =>
        (await request<{ status: StatusSetting }>("PATCH", `${team(teamKey)}/statuses/${encodeURIComponent(status)}`, patch)).status,
      /** Every status of the team, in the order wanted; roles stay grouped. Answers the list. */
      reorder: async (teamKey: string, ids: string[]) => (await request<{ statuses: StatusSetting[] }>("PUT", `${team(teamKey)}/statuses/order`, { ids })).statuses,
      /** A status with issues needs `moveTo` (an id or a name) to say where they go; the last status of a required role stays. */
      remove: (teamKey: string, status: string, moveTo?: string) =>
        request<{ ok: true; deleted: string; moved: number }>("DELETE", `${team(teamKey)}/statuses/${encodeURIComponent(status)}${moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ""}`),
    },

    issues: {
      create: async (teamKey: string, input: NewIssue) =>
        (await request<{ issue: IssueView & { status: string | undefined } }>("POST", `/api/app/teams/${encodeURIComponent(teamKey)}/issues`, input)).issue,
      get: (ref: string) => request<IssueDetail>("GET", `/api/app/issues/${encodeURIComponent(ref)}`),
      /** With `version`, a stale edit rejects with an ApiError whose `current` is the issue as it is now. */
      update: async (ref: string, patch: IssuePatch) => (await request<{ issue: IssueView }>("PATCH", `/api/app/issues/${encodeURIComponent(ref)}`, patch)).issue,
      move: async (ref: string, move: MoveIssue) =>
        (await request<{ issue: IssueView & { status: string | undefined } }>("POST", `/api/app/issues/${encodeURIComponent(ref)}/move`, move)).issue,
      remove: (ref: string) => request<{ ok: true }>("DELETE", `/api/app/issues/${encodeURIComponent(ref)}`),
      comment: async (ref: string, body: string) => (await request<{ comment: IssueComment }>("POST", `/api/app/issues/${encodeURIComponent(ref)}/comments`, { body })).comment,
      link: (ref: string, nodeId: string) => request<{ ok: true }>("PUT", `/api/app/issues/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`, {}),
      unlink: (ref: string, nodeId: string) => request<{ ok: true }>("DELETE", `/api/app/issues/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`),
    },

    map: {
      /** The whole map in one read; also what the decisions and glossary pages draw. */
      graph: (teamKey: string) => request<GraphView>("GET", `/api/app/teams/${encodeURIComponent(teamKey)}/graph`),
      /** Create (no `id`) or change (`id`) a node. With `version`, a stale change rejects with an ApiError whose `current` is the node now. */
      upsertNode: async (teamKey: string, patch: NodePatch) =>
        (await request<{ node: MapNode }>("PUT", `/api/app/teams/${encodeURIComponent(teamKey)}/nodes`, patch)).node,
      deleteNode: (teamKey: string, id: string) => request<{ ok: true }>("DELETE", `/api/app/teams/${encodeURIComponent(teamKey)}/nodes/${encodeURIComponent(id)}`),
      markFresh: async (teamKey: string, id: string) =>
        (await request<{ node: MapNode }>("POST", `/api/app/teams/${encodeURIComponent(teamKey)}/nodes/${encodeURIComponent(id)}/fresh`, {})).node,
      saveLayout: (teamKey: string, positions: NodePosition[], opts: { placed?: boolean } = {}) =>
        request<{ ok: true }>("PUT", `/api/app/teams/${encodeURIComponent(teamKey)}/layout`, { positions, ...opts }),
      connect: async (teamKey: string, input: { from: string; to: string; label?: string; kind?: "depends" | "implements" }) =>
        (await request<{ edge: MapEdge }>("POST", `/api/app/teams/${encodeURIComponent(teamKey)}/edges`, input)).edge,
      deleteEdge: (teamKey: string, id: string) => request<{ ok: true }>("DELETE", `/api/app/teams/${encodeURIComponent(teamKey)}/edges/${encodeURIComponent(id)}`),
      upsertFlow: async (teamKey: string, input: FlowInput) => (await request<{ flow: Flow }>("PUT", `/api/app/teams/${encodeURIComponent(teamKey)}/flows`, input)).flow,
      deleteFlow: (teamKey: string, id: string) => request<{ ok: true }>("DELETE", `/api/app/teams/${encodeURIComponent(teamKey)}/flows/${encodeURIComponent(id)}`),
      upsertDecision: async (teamKey: string, input: DecisionInput) =>
        (await request<{ decision: Decision }>("PUT", `/api/app/teams/${encodeURIComponent(teamKey)}/decisions`, input)).decision,
      upsertTerm: async (teamKey: string, term: string, input: { definition: string; node?: string | null }) =>
        (await request<{ term: Term }>("PUT", `/api/app/teams/${encodeURIComponent(teamKey)}/terms/${encodeURIComponent(term)}`, input)).term,
      deleteTerm: (teamKey: string, term: string) => request<{ ok: true }>("DELETE", `/api/app/teams/${encodeURIComponent(teamKey)}/terms/${encodeURIComponent(term)}`),
      resolveDraft: (teamKey: string, id: string, action: "publish" | "discard") =>
        request<{ ok: true }>("POST", `/api/app/teams/${encodeURIComponent(teamKey)}/drafts/${encodeURIComponent(id)}/resolve`, { action }),
      /** Answered by Claude on the server, from the map. */
      ask: (teamKey: string, question: string, focus?: string) =>
        request<AskAnswer>("POST", `/api/app/teams/${encodeURIComponent(teamKey)}/ask`, { question, ...(focus ? { focus } : {}) }),
      activity: async (teamKey: string, who?: "agent" | "human") =>
        (await request<{ events: ActivityEvent2[] }>("GET", `/api/app/teams/${encodeURIComponent(teamKey)}/activity${who ? `?who=${who}` : ""}`)).events,
    },

    docs: {
      /** The tree, and what the page's side panels offer. */
      index: (teamKey: string) => request<DocsIndex>("GET", `${team(teamKey)}/docs`),
      get: (teamKey: string, ref: string) => request<DocDetail>("GET", `${team(teamKey)}/docs/${encodeURIComponent(ref)}`),
      create: async (teamKey: string, input: NewDoc) => (await request<{ doc: Doc }>("POST", `${team(teamKey)}/docs`, input)).doc,
      /** With `version`, a doc changed since rejects with an ApiError whose `current` is the doc now. */
      update: async (teamKey: string, ref: string, patch: DocPatch) => (await request<{ doc: Doc }>("PATCH", `${team(teamKey)}/docs/${encodeURIComponent(ref)}`, patch)).doc,
      markFresh: async (teamKey: string, ref: string) => (await request<{ doc: Doc }>("POST", `${team(teamKey)}/docs/${encodeURIComponent(ref)}/fresh`, {})).doc,
      anchorSuggestions: async (teamKey: string, ref: string) =>
        (await request<{ anchors: string[] }>("GET", `${team(teamKey)}/docs/${encodeURIComponent(ref)}/anchor-suggestions`)).anchors,
      move: async (teamKey: string, ref: string, to: { parent?: string | null; index?: number; version?: number }) =>
        (await request<{ doc: Doc }>("POST", `${team(teamKey)}/docs/${encodeURIComponent(ref)}/move`, to)).doc,
      delete: (teamKey: string, ref: string) => request<{ ok: true }>("DELETE", `${team(teamKey)}/docs/${encodeURIComponent(ref)}`),
      linkNode: (teamKey: string, ref: string, nodeId: string) =>
        request<{ ok: true }>("PUT", `${team(teamKey)}/docs/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`, {}),
      unlinkNode: (teamKey: string, ref: string, nodeId: string) =>
        request<{ ok: true }>("DELETE", `${team(teamKey)}/docs/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`),
    },

    projects: {
      /** The projects the person can see (through a team of theirs that takes part), active first. */
      list: async () => (await request<{ projects: ProjectSummary[] }>("GET", "/api/app/projects")).projects,
      /** One project: milestones, the viewer's own teams with their issues, the other teams as totals. */
      get: async (id: string) => (await request<{ project: ProjectDetail }>("GET", `/api/app/projects/${encodeURIComponent(id)}`)).project,
      create: async (input: ProjectInput & { name: string; leadTeam: string }) => (await request<{ project: ProjectDetail }>("POST", "/api/app/projects", input)).project,
      /** With `version`, a project changed since rejects with a 409. */
      update: async (id: string, patch: ProjectInput) => (await request<{ project: ProjectDetail }>("PATCH", `/api/app/projects/${encodeURIComponent(id)}`, patch)).project,
      /** Its issues stay on their boards, in no project. */
      delete: (id: string) => request<{ ok: true; released: number }>("DELETE", `/api/app/projects/${encodeURIComponent(id)}`),
      addTeam: async (id: string, teamKey: string) => (await request<{ project: ProjectDetail }>("POST", `/api/app/projects/${encodeURIComponent(id)}/teams`, { team: teamKey })).project,
      /** A team with issues in the project is refused (409) unless `releaseIssues`; the lead team cannot go. */
      removeTeam: (id: string, teamKey: string, o: { releaseIssues?: boolean } = {}) =>
        request<{ ok: true; released: number }>("DELETE", `/api/app/projects/${encodeURIComponent(id)}/teams/${encodeURIComponent(teamKey)}${o.releaseIssues ? "?releaseIssues=1" : ""}`),
      addMilestone: async (id: string, input: MilestoneInput & { name: string }) => (await request<{ project: ProjectDetail }>("POST", `/api/app/projects/${encodeURIComponent(id)}/milestones`, input)).project,
      updateMilestone: async (id: string, milestoneId: string, patch: MilestoneInput) =>
        (await request<{ project: ProjectDetail }>("PATCH", `/api/app/projects/${encodeURIComponent(id)}/milestones/${encodeURIComponent(milestoneId)}`, patch)).project,
      deleteMilestone: async (id: string, milestoneId: string) =>
        (await request<{ project: ProjectDetail }>("DELETE", `/api/app/projects/${encodeURIComponent(id)}/milestones/${encodeURIComponent(milestoneId)}`)).project,
    },

    initiatives: {
      /** Every initiative of the workspace, parents before their children, with roll-up progress. Empty for a guest. */
      list: async () => (await request<{ initiatives: InitiativeSummary[] }>("GET", "/api/app/initiatives")).initiatives,
      get: async (id: string) => (await request<{ initiative: InitiativeDetail }>("GET", `/api/app/initiatives/${encodeURIComponent(id)}`)).initiative,
      create: async (input: InitiativeInput & { name: string }) => (await request<{ initiative: InitiativeDetail }>("POST", "/api/app/initiatives", input)).initiative,
      /** With `version`, an initiative changed since rejects with a 409. */
      update: async (id: string, patch: InitiativeInput) => (await request<{ initiative: InitiativeDetail }>("PATCH", `/api/app/initiatives/${encodeURIComponent(id)}`, patch)).initiative,
      /** Its sub-initiatives move up; the projects stay. */
      delete: (id: string) => request<{ ok: true; moved: number; unlinked: number }>("DELETE", `/api/app/initiatives/${encodeURIComponent(id)}`),
      linkProject: async (id: string, projectId: string) => (await request<{ initiative: InitiativeDetail }>("POST", `/api/app/initiatives/${encodeURIComponent(id)}/projects`, { projectId })).initiative,
      unlinkProject: async (id: string, projectId: string) =>
        (await request<{ initiative: InitiativeDetail }>("DELETE", `/api/app/initiatives/${encodeURIComponent(id)}/projects/${encodeURIComponent(projectId)}`)).initiative,
    },

    cycles: {
      /** The team's cycles by when they are. An ended cycle has handed its unfinished issues on before this answers. */
      list: (teamKey: string) => request<CycleList>("GET", `${team(teamKey)}/cycles`),
      /** One cycle: its issues and what landed while it ran. */
      get: async (teamKey: string, number: number) => (await request<{ cycle: CycleDetail }>("GET", `${team(teamKey)}/cycles/${number}`)).cycle,
      create: async (teamKey: string, input: CycleInput) => (await request<{ cycle: CycleSummary }>("POST", `${team(teamKey)}/cycles`, input)).cycle,
      update: async (teamKey: string, number: number, patch: CycleInput) => (await request<{ cycle: CycleSummary }>("PATCH", `${team(teamKey)}/cycles/${number}`, patch)).cycle,
      /** Its issues stay on the board, in no cycle. */
      delete: (teamKey: string, number: number) => request<{ ok: true; number: number; released: number }>("DELETE", `${team(teamKey)}/cycles/${number}`),
    },

    repos: {
      list: async (teamKey: string) => (await request<{ repositories: Repository[] }>("GET", `${team(teamKey)}/repositories`)).repositories,
      create: async (teamKey: string, input: RepositoryInput & { displayName: string; role: string }) =>
        (await request<{ repository: Repository }>("POST", `${team(teamKey)}/repositories`, input)).repository,
      update: async (teamKey: string, id: string, patch: RepositoryInput) =>
        (await request<{ repository: Repository }>("PATCH", `${team(teamKey)}/repositories/${encodeURIComponent(id)}`, patch)).repository,
      retire: async (teamKey: string, id: string) =>
        (await request<{ repository: Repository }>("POST", `${team(teamKey)}/repositories/${encodeURIComponent(id)}/retire`, {})).repository,
      /** The file paths of a connected GitHub repository's default branch. */
      tree: (teamKey: string, id: string) =>
        request<{ files: string[]; truncated: boolean }>("GET", `${team(teamKey)}/repositories/${encodeURIComponent(id)}/tree`),
      /** Is GitHub set up here, and (owners) which repositories of the workspace's installations could still be connected. */
      github: (teamKey: string) => request<GithubStatus>("GET", `${team(teamKey)}/repositories/github`),
      connectGithub: async (teamKey: string, input: { installationId: string; repoId: string; role?: string; pathLimit?: string | null }) =>
        (await request<{ repository: Repository }>("POST", `${team(teamKey)}/repositories/github`, input)).repository,
    },

    onboarding: {
      page: (teamKey: string) => request<OnboardingPage>("GET", `${team(teamKey)}/onboarding`),
      /** The "no code yet" path: a few sentences become the map's first concept. */
      startMap: (teamKey: string, description: string) => request<{ ok: true }>("POST", `${team(teamKey)}/onboarding/concept`, { description }),
    },

    /** Change your own password. */
    changePassword: (input: { current: string; next: string }) => request<{ ok: true }>("POST", "/api/app/me/password", input),

    workspace: {
      overview: () => request<WorkspaceOverview>("GET", "/api/app/workspace"),
      /** Owners only. `tags` as a list or a comma-separated string. */
      updateMember: async (userId: string, input: { role: Role; tags: string[] | string }) =>
        (await request<{ member: WorkspaceMember }>("PATCH", `/api/app/workspace/members/${encodeURIComponent(userId)}`, input)).member,
      removeMember: (userId: string) => request<{ ok: true }>("DELETE", `/api/app/workspace/members/${encodeURIComponent(userId)}`),
    },

    agents: {
      /** The workspace's keys (never their values) and the commands for connecting an agent. */
      page: () => request<AgentsPage>("GET", "/api/app/agents"),
      /** Reset an agent's queue: one key and/or one team, or everything. */
      markAllSeen: (input: { keyId?: string; teamKey?: string } = {}) => request<{ ok: true }>("POST", "/api/app/agents/mark-all-seen", input),
    },

    keys: {
      /** The secret is in this response only. `teams` are the keys of the teams it can open (teams you edit, at least one); left out, all of them. */
      create: (name: string, teams?: string[]) => request<CreatedKey>("POST", "/api/app/keys", teams ? { name, teams } : { name }),
      /** Set the teams the key can open; takes effect on its next call. */
      setTeams: async (id: string, teams: string[]) => (await request<{ key: KeyView }>("PATCH", `/api/app/keys/${encodeURIComponent(id)}`, { teams })).key,
      revoke: (id: string) => request<{ ok: true }>("DELETE", `/api/app/keys/${encodeURIComponent(id)}`),
      setDocsWrite: async (id: string, docsWrite: boolean) => (await request<{ key: KeyView }>("PATCH", `/api/app/keys/${encodeURIComponent(id)}`, { docsWrite })).key,
    },

    invites: {
      /** Pending invites: join invites of your workspace (owners), or new-workspace invites (instance admins). */
      list: async (kind: "join_workspace" | "new_workspace" = "join_workspace") =>
        (await request<{ invites: PendingInvite[] }>("GET", `/api/app/invites?kind=${kind}`)).invites,
      create: (input: CreateInviteInput) => request<CreatedInvite>("POST", "/api/app/invites", input),
      revoke: (id: string) => request<{ ok: true }>("DELETE", `/api/app/invites/${encodeURIComponent(id)}`),
      /** For the invite page, before anyone is signed in. */
      peek: async (token: string) => (await request<{ invite: InvitePeek }>("POST", "/api/app/invites/peek", { token })).invite,
      /** For a signed-in person with an account: what an invite sent to their own address adds them to. */
      peekExisting: async (token: string) => (await request<{ invite: InvitePeekExisting }>("POST", "/api/app/invites/peek-existing", { token })).invite,
      /** For a signed-in person with an account: join that workspace; this session then works in it. */
      acceptExisting: async (token: string) => (await request<{ workspace: { id: string; name: string } }>("POST", "/api/app/invites/accept-existing", { token })).workspace,
      /** Creates the account and signs the new person in. */
      accept: async (input: AcceptInviteInput) => adopt(await request<Me>("POST", "/api/app/invites/accept", input)),
    },

    admin: {
      workspaces: async () => (await request<{ workspaces: AdminWorkspace[] }>("GET", "/api/app/admin/workspaces")).workspaces,
      workspace: async (id: string) => (await request<{ workspace: AdminWorkspaceDetail }>("GET", `/api/app/admin/workspaces/${encodeURIComponent(id)}`)).workspace,
      suspend: (id: string, input: { confirm: string; reason?: string }) =>
        request<{ name: string; sessionsEnded: number }>("POST", `/api/app/admin/workspaces/${encodeURIComponent(id)}/suspend`, input),
      restore: (id: string) => request<{ ok: true }>("POST", `/api/app/admin/workspaces/${encodeURIComponent(id)}/restore`, {}),
    },

    /** Your machines (the agent daemon): pairing one, its settings, unpairing it. */
    devices: {
      list: async () => (await request<{ devices: DeviceView[] }>("GET", "/api/app/devices")).devices,
      /** The machine behind the code `wheelhouse-daemon pair` printed. */
      peekPairing: (code: string) => request<PairingPeek>("GET", `/api/app/devices/pair?code=${encodeURIComponent(code)}`),
      approvePairing: async (code: string, name?: string) => (await request<{ device: DeviceView }>("POST", "/api/app/devices/pair", name ? { code, name } : { code })).device,
      denyPairing: (code: string) => request<{ ok: true }>("POST", "/api/app/devices/pair/deny", { code }),
      update: async (id: string, patch: { name?: string; poolSize?: number; chatModel?: string | null }) =>
        (await request<{ device: DeviceView }>("PATCH", `/api/app/devices/${encodeURIComponent(id)}`, patch)).device,
      /** Its token stops working and what it was running is canceled. */
      unpair: (id: string) => request<{ ok: true; canceled: number }>("DELETE", `/api/app/devices/${encodeURIComponent(id)}`),
    },

    /** Runs of an issue on a device: an agent working on it in a worktree on that machine. */
    runs: {
      forIssue: (ref: string) => request<IssueRuns>("GET", `/api/app/issues/${encodeURIComponent(ref)}/jobs`),
      /** The branches a run in that repository can start from. */
      branches: (ref: string, repositoryId: string) =>
        request<RunBranches>("GET", `/api/app/issues/${encodeURIComponent(ref)}/jobs/branches?repositoryId=${encodeURIComponent(repositoryId)}`),
      start: async (ref: string, input: { deviceId: string; repositoryId?: string; model: string; baseBranch?: string }) =>
        (await request<{ job: JobView }>("POST", `/api/app/issues/${encodeURIComponent(ref)}/jobs`, input)).job,
      /** Progress after event number `after`. */
      events: (id: string, after?: number) =>
        request<{ job: JobView; events: JobEvent[] }>("GET", `/api/app/jobs/${encodeURIComponent(id)}/events${after !== undefined ? `?after=${after}` : ""}`),
      /** An offer ends at once; a run in progress is asked to stop. */
      cancel: async (id: string) => (await request<{ job: JobView }>("POST", `/api/app/jobs/${encodeURIComponent(id)}/cancel`, {})).job,
    },

    dashboard: {
      /** One widget's data. */
      widget: <W extends keyof DashboardWidgets>(widget: W, team?: string) =>
        request<DashboardWidgets[W]>("GET", `/api/app/dashboard/${widget}${team ? `?team=${encodeURIComponent(team)}` : ""}`),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
