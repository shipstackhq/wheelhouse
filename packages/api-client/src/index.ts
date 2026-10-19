/**
 * A typed client for the web app's API (/api/app, WH-93). Only `fetch`, so it runs in the browser and in tests.
 *
 *   const api = createApiClient();                       // same origin, as the React app is served
 *   const me = await api.me();                           // null when signed out
 *   await api.auth.login({ email, password });
 *   const projects = await api.projects.list();
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
  ProjectMembers,
  ProjectRole,
  WorkspaceProject,
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
  AdminTeam,
  AdminTeamDetail,
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
  CreateInviteInput,
  DashboardWidgets,
  InvitePeek,
  KeyView,
  MoveTicket,
  NewTicket,
  PendingInvite,
  Role,
  TeamMember,
  TeamOverview,
  TicketComment,
  TicketDetail,
  TicketPatch,
  TicketView,
} from "./types";

export type * from "./types";

export type Me = {
  user: { id: string; name: string; email: string };
  team: { id: string; name: string };
  role: Role;
  /** The person's labels within the team (for example "eng"). */
  tags: string[];
  isInstanceAdmin: boolean;
  /** Sent back as X-CSRF-Token on state-changing requests; the client does this for you. */
  csrfToken: string;
};

export type Project = { id: string; key: string; name: string; description: string; createdAt: string; /** The caller's own role in it. */ role?: ProjectRole };
export type CreateProjectInput = { name: string; key?: string; description?: string };

export type LoginInput = { email: string; password: string };
export type SignupInput = { name: string; email: string; password: string; team?: string };

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

  const project = (key: string) => `/api/app/projects/${encodeURIComponent(key)}`;

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
      switchTo: async (teamId: string) => (await request<{ team: { id: string; name: string } }>("POST", "/api/app/me/workspace", { teamId })).team,
    },

    /** Workspace-level views of access (owners and admins). */
    access: {
      projects: async () => (await request<{ projects: WorkspaceProject[] }>("GET", "/api/app/access/projects")).projects,
      audit: async (opts: { project?: string; limit?: number } = {}) => {
        const q = new URLSearchParams();
        if (opts.project) q.set("project", opts.project);
        if (opts.limit) q.set("limit", String(opts.limit));
        return (await request<{ events: AuditEvent[] }>("GET", `/api/app/access/audit${q.size ? `?${q}` : ""}`)).events;
      },
    },

    projects: {
      list: async () => (await request<{ projects: Project[] }>("GET", "/api/app/projects")).projects,
      create: async (input: CreateProjectInput) => (await request<{ project: Project }>("POST", "/api/app/projects", input)).project,
      /** Project settings: rename it or change its description (project admins). */
      update: async (projectKey: string, input: { name?: string; description?: string }) =>
        (await request<{ project: Project }>("PATCH", `/api/app/projects/${encodeURIComponent(projectKey)}`, input)).project,
      /** The project page in one read: columns, tickets, map nodes, members and the setup checklist. */
      board: (projectKey: string) => request<BoardView>("GET", `/api/app/projects/${encodeURIComponent(projectKey)}/board`),
      /** The Bots menu: each agent key with its queue in this project. */
      queue: async (projectKey: string) => (await request<{ bots: Bot[] }>("GET", `/api/app/projects/${encodeURIComponent(projectKey)}/queue`)).bots,
      /** Who is in the project, and the caller's own role in it. */
      members: (projectKey: string) => request<ProjectMembers>("GET", `${project(projectKey)}/members`),
      /** Workspace members who could still be added (project admins). */
      addableMembers: async (projectKey: string) => (await request<{ people: AddableMember[] }>("GET", `${project(projectKey)}/members/addable`)).people,
      addMember: (projectKey: string, input: { userId: string; role: ProjectRole }) => request<{ member: { userId: string; role: ProjectRole } }>("POST", `${project(projectKey)}/members`, input),
      setMemberRole: (projectKey: string, userId: string, role: ProjectRole) =>
        request<{ member: { userId: string; role: ProjectRole } }>("PATCH", `${project(projectKey)}/members/${encodeURIComponent(userId)}`, { role }),
      /** Remove someone from the project, or leave it yourself. */
      removeMember: (projectKey: string, userId: string) => request<{ ok: true }>("DELETE", `${project(projectKey)}/members/${encodeURIComponent(userId)}`),
      /** A workspace owner or admin joins the project as its admin (audited). */
      join: (projectKey: string) => request<{ project: { id: string; key: string; name: string } }>("POST", `${project(projectKey)}/join`, {}),
      /** Teammates remove an agent session from a project. */
      removeSession: (projectKey: string, sessionId: string) =>
        request<{ ok: true }>("DELETE", `/api/app/projects/${encodeURIComponent(projectKey)}/sessions/${encodeURIComponent(sessionId)}`),
    },

    tickets: {
      create: async (projectKey: string, input: NewTicket) =>
        (await request<{ ticket: TicketView & { column: string | undefined } }>("POST", `/api/app/projects/${encodeURIComponent(projectKey)}/tickets`, input)).ticket,
      get: (ref: string) => request<TicketDetail>("GET", `/api/app/tickets/${encodeURIComponent(ref)}`),
      /** With `version`, a stale edit rejects with an ApiError whose `current` is the ticket as it is now. */
      update: async (ref: string, patch: TicketPatch) => (await request<{ ticket: TicketView }>("PATCH", `/api/app/tickets/${encodeURIComponent(ref)}`, patch)).ticket,
      move: async (ref: string, move: MoveTicket) =>
        (await request<{ ticket: TicketView & { column: string | undefined } }>("POST", `/api/app/tickets/${encodeURIComponent(ref)}/move`, move)).ticket,
      remove: (ref: string) => request<{ ok: true }>("DELETE", `/api/app/tickets/${encodeURIComponent(ref)}`),
      comment: async (ref: string, body: string) => (await request<{ comment: TicketComment }>("POST", `/api/app/tickets/${encodeURIComponent(ref)}/comments`, { body })).comment,
      link: (ref: string, nodeId: string) => request<{ ok: true }>("PUT", `/api/app/tickets/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`, {}),
      unlink: (ref: string, nodeId: string) => request<{ ok: true }>("DELETE", `/api/app/tickets/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`),
    },

    map: {
      /** The whole map in one read; also what the decisions and glossary pages draw. */
      graph: (projectKey: string) => request<GraphView>("GET", `/api/app/projects/${encodeURIComponent(projectKey)}/graph`),
      /** Create (no `id`) or change (`id`) a node. With `version`, a stale change rejects with an ApiError whose `current` is the node now. */
      upsertNode: async (projectKey: string, patch: NodePatch) =>
        (await request<{ node: MapNode }>("PUT", `/api/app/projects/${encodeURIComponent(projectKey)}/nodes`, patch)).node,
      deleteNode: (projectKey: string, id: string) => request<{ ok: true }>("DELETE", `/api/app/projects/${encodeURIComponent(projectKey)}/nodes/${encodeURIComponent(id)}`),
      markFresh: async (projectKey: string, id: string) =>
        (await request<{ node: MapNode }>("POST", `/api/app/projects/${encodeURIComponent(projectKey)}/nodes/${encodeURIComponent(id)}/fresh`, {})).node,
      saveLayout: (projectKey: string, positions: NodePosition[], opts: { placed?: boolean } = {}) =>
        request<{ ok: true }>("PUT", `/api/app/projects/${encodeURIComponent(projectKey)}/layout`, { positions, ...opts }),
      connect: async (projectKey: string, input: { from: string; to: string; label?: string; kind?: "depends" | "implements" }) =>
        (await request<{ edge: MapEdge }>("POST", `/api/app/projects/${encodeURIComponent(projectKey)}/edges`, input)).edge,
      deleteEdge: (projectKey: string, id: string) => request<{ ok: true }>("DELETE", `/api/app/projects/${encodeURIComponent(projectKey)}/edges/${encodeURIComponent(id)}`),
      upsertFlow: async (projectKey: string, input: FlowInput) => (await request<{ flow: Flow }>("PUT", `/api/app/projects/${encodeURIComponent(projectKey)}/flows`, input)).flow,
      deleteFlow: (projectKey: string, id: string) => request<{ ok: true }>("DELETE", `/api/app/projects/${encodeURIComponent(projectKey)}/flows/${encodeURIComponent(id)}`),
      upsertDecision: async (projectKey: string, input: DecisionInput) =>
        (await request<{ decision: Decision }>("PUT", `/api/app/projects/${encodeURIComponent(projectKey)}/decisions`, input)).decision,
      upsertTerm: async (projectKey: string, term: string, input: { definition: string; node?: string | null }) =>
        (await request<{ term: Term }>("PUT", `/api/app/projects/${encodeURIComponent(projectKey)}/terms/${encodeURIComponent(term)}`, input)).term,
      deleteTerm: (projectKey: string, term: string) => request<{ ok: true }>("DELETE", `/api/app/projects/${encodeURIComponent(projectKey)}/terms/${encodeURIComponent(term)}`),
      resolveDraft: (projectKey: string, id: string, action: "publish" | "discard") =>
        request<{ ok: true }>("POST", `/api/app/projects/${encodeURIComponent(projectKey)}/drafts/${encodeURIComponent(id)}/resolve`, { action }),
      /** Answered by Claude on the server, from the map. */
      ask: (projectKey: string, question: string, focus?: string) =>
        request<AskAnswer>("POST", `/api/app/projects/${encodeURIComponent(projectKey)}/ask`, { question, ...(focus ? { focus } : {}) }),
      activity: async (projectKey: string, who?: "agent" | "human") =>
        (await request<{ events: ActivityEvent2[] }>("GET", `/api/app/projects/${encodeURIComponent(projectKey)}/activity${who ? `?who=${who}` : ""}`)).events,
    },

    docs: {
      /** The tree, and what the page's side panels offer. */
      index: (projectKey: string) => request<DocsIndex>("GET", `${project(projectKey)}/docs`),
      get: (projectKey: string, ref: string) => request<DocDetail>("GET", `${project(projectKey)}/docs/${encodeURIComponent(ref)}`),
      create: async (projectKey: string, input: NewDoc) => (await request<{ doc: Doc }>("POST", `${project(projectKey)}/docs`, input)).doc,
      /** With `version`, a doc changed since rejects with an ApiError whose `current` is the doc now. */
      update: async (projectKey: string, ref: string, patch: DocPatch) => (await request<{ doc: Doc }>("PATCH", `${project(projectKey)}/docs/${encodeURIComponent(ref)}`, patch)).doc,
      markFresh: async (projectKey: string, ref: string) => (await request<{ doc: Doc }>("POST", `${project(projectKey)}/docs/${encodeURIComponent(ref)}/fresh`, {})).doc,
      anchorSuggestions: async (projectKey: string, ref: string) =>
        (await request<{ anchors: string[] }>("GET", `${project(projectKey)}/docs/${encodeURIComponent(ref)}/anchor-suggestions`)).anchors,
      move: async (projectKey: string, ref: string, to: { parent?: string | null; index?: number; version?: number }) =>
        (await request<{ doc: Doc }>("POST", `${project(projectKey)}/docs/${encodeURIComponent(ref)}/move`, to)).doc,
      delete: (projectKey: string, ref: string) => request<{ ok: true }>("DELETE", `${project(projectKey)}/docs/${encodeURIComponent(ref)}`),
      linkNode: (projectKey: string, ref: string, nodeId: string) =>
        request<{ ok: true }>("PUT", `${project(projectKey)}/docs/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`, {}),
      unlinkNode: (projectKey: string, ref: string, nodeId: string) =>
        request<{ ok: true }>("DELETE", `${project(projectKey)}/docs/${encodeURIComponent(ref)}/nodes/${encodeURIComponent(nodeId)}`),
    },

    repos: {
      list: async (projectKey: string) => (await request<{ repositories: Repository[] }>("GET", `${project(projectKey)}/repositories`)).repositories,
      create: async (projectKey: string, input: RepositoryInput & { displayName: string; role: string }) =>
        (await request<{ repository: Repository }>("POST", `${project(projectKey)}/repositories`, input)).repository,
      update: async (projectKey: string, id: string, patch: RepositoryInput) =>
        (await request<{ repository: Repository }>("PATCH", `${project(projectKey)}/repositories/${encodeURIComponent(id)}`, patch)).repository,
      retire: async (projectKey: string, id: string) =>
        (await request<{ repository: Repository }>("POST", `${project(projectKey)}/repositories/${encodeURIComponent(id)}/retire`, {})).repository,
      /** The file paths of a connected GitHub repository's default branch. */
      tree: (projectKey: string, id: string) =>
        request<{ files: string[]; truncated: boolean }>("GET", `${project(projectKey)}/repositories/${encodeURIComponent(id)}/tree`),
      /** Is GitHub set up here, and (owners) which repositories of the team's installations could still be connected. */
      github: (projectKey: string) => request<GithubStatus>("GET", `${project(projectKey)}/repositories/github`),
      connectGithub: async (projectKey: string, input: { installationId: string; repoId: string; role?: string; pathLimit?: string | null }) =>
        (await request<{ repository: Repository }>("POST", `${project(projectKey)}/repositories/github`, input)).repository,
    },

    onboarding: {
      page: (projectKey: string) => request<OnboardingPage>("GET", `${project(projectKey)}/onboarding`),
      /** The "no code yet" path: a few sentences become the map's first concept. */
      startMap: (projectKey: string, description: string) => request<{ ok: true }>("POST", `${project(projectKey)}/onboarding/concept`, { description }),
    },

    /** Change your own password. */
    changePassword: (input: { current: string; next: string }) => request<{ ok: true }>("POST", "/api/app/me/password", input),

    team: {
      overview: () => request<TeamOverview>("GET", "/api/app/team"),
      /** Owners only. `tags` as a list or a comma-separated string. */
      updateMember: async (userId: string, input: { role: Role; tags: string[] | string }) =>
        (await request<{ member: TeamMember }>("PATCH", `/api/app/team/members/${encodeURIComponent(userId)}`, input)).member,
      removeMember: (userId: string) => request<{ ok: true }>("DELETE", `/api/app/team/members/${encodeURIComponent(userId)}`),
    },

    agents: {
      /** The team's keys (never their values) and the commands for connecting an agent. */
      page: () => request<AgentsPage>("GET", "/api/app/agents"),
      /** Reset an agent's queue: one key and/or one project, or everything. */
      markAllSeen: (input: { keyId?: string; projectKey?: string } = {}) => request<{ ok: true }>("POST", "/api/app/agents/mark-all-seen", input),
    },

    keys: {
      /** The secret is in this response only. */
      create: (name: string) => request<CreatedKey>("POST", "/api/app/keys", { name }),
      revoke: (id: string) => request<{ ok: true }>("DELETE", `/api/app/keys/${encodeURIComponent(id)}`),
      setDocsWrite: async (id: string, docsWrite: boolean) => (await request<{ key: KeyView }>("PATCH", `/api/app/keys/${encodeURIComponent(id)}`, { docsWrite })).key,
    },

    invites: {
      /** Pending invites: join invites of your team (owners), or new-team invites (instance admins). */
      list: async (kind: "join_team" | "new_team" = "join_team") =>
        (await request<{ invites: PendingInvite[] }>("GET", `/api/app/invites?kind=${kind}`)).invites,
      create: (input: CreateInviteInput) => request<CreatedInvite>("POST", "/api/app/invites", input),
      revoke: (id: string) => request<{ ok: true }>("DELETE", `/api/app/invites/${encodeURIComponent(id)}`),
      /** For the invite page, before anyone is signed in. */
      peek: async (token: string) => (await request<{ invite: InvitePeek }>("POST", "/api/app/invites/peek", { token })).invite,
      /** For a signed-in person with an account: what an invite sent to their own address adds them to. */
      peekExisting: async (token: string) => (await request<{ invite: InvitePeekExisting }>("POST", "/api/app/invites/peek-existing", { token })).invite,
      /** For a signed-in person with an account: join that workspace; this session then works in it. */
      acceptExisting: async (token: string) => (await request<{ team: { id: string; name: string } }>("POST", "/api/app/invites/accept-existing", { token })).team,
      /** Creates the account and signs the new person in. */
      accept: async (input: AcceptInviteInput) => adopt(await request<Me>("POST", "/api/app/invites/accept", input)),
    },

    admin: {
      teams: async () => (await request<{ teams: AdminTeam[] }>("GET", "/api/app/admin/teams")).teams,
      team: async (id: string) => (await request<{ team: AdminTeamDetail }>("GET", `/api/app/admin/teams/${encodeURIComponent(id)}`)).team,
      suspend: (id: string, input: { confirm: string; reason?: string }) =>
        request<{ name: string; sessionsEnded: number }>("POST", `/api/app/admin/teams/${encodeURIComponent(id)}/suspend`, input),
      restore: (id: string) => request<{ ok: true }>("POST", `/api/app/admin/teams/${encodeURIComponent(id)}/restore`, {}),
    },

    dashboard: {
      /** One widget's data. */
      widget: <W extends keyof DashboardWidgets>(widget: W, project?: string) =>
        request<DashboardWidgets[W]>("GET", `/api/app/dashboard/${widget}${project ? `?project=${encodeURIComponent(project)}` : ""}`),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
