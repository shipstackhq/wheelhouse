import { useQuery } from "@tanstack/react-query";
import type { ApiClient, DashboardWidgets } from "@wheelhouse/api-client";
import { useDashboardTeam } from "./dashboard-scope";
import { useServices } from "./services";
import { wsKey } from "./workspace";

/** What each page reads. Keys are grouped (workspace, api-keys, invites, admin, dashboard) so a change can refresh a whole group. */
export const workspaceQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "workspace"), queryFn: () => api.workspace.overview() });
export const apiKeysQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "api-keys"), queryFn: () => api.keys.page() });
export const invitesQuery = (api: ApiClient, kind: "join_workspace" | "new_workspace") => ({ queryKey: wsKey(api, "invites", kind), queryFn: () => api.invites.list(kind) });
export const adminWorkspacesQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "admin", "workspaces"), queryFn: () => api.admin.workspaces() });
export const adminWorkspaceQuery = (api: ApiClient, id: string) => ({ queryKey: wsKey(api, "admin", "workspace", id), queryFn: () => api.admin.workspace(id) });
export const widgetQuery = <W extends keyof DashboardWidgets>(api: ApiClient, widget: W, team: string | null = null) => ({
  queryKey: wsKey(api, "dashboard", widget, team ?? "*"),
  queryFn: () => api.dashboard.widget(widget, team ?? undefined),
});

export const useWorkspace = () => useQuery(workspaceQuery(useServices().api));
export const useApiKeysPage = () => useQuery(apiKeysQuery(useServices().api));
export const useInvites = (kind: "join_workspace" | "new_workspace") => useQuery(invitesQuery(useServices().api, kind));
export const useAdminWorkspaces = () => useQuery(adminWorkspacesQuery(useServices().api));
export const useAdminWorkspace = (id: string) => useQuery(adminWorkspaceQuery(useServices().api, id));
/** A widget's data, for the workspace or, inside a team's Overview, for that team (see lib/dashboard-scope). */
export const useWidget = <W extends keyof DashboardWidgets>(widget: W) => useQuery(widgetQuery(useServices().api, widget, useDashboardTeam()));

/** The team page and its issue dialog. Grouped under "board", "issue" and "queue" so a change refreshes the right ones. */
export const boardQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "board", teamKey), queryFn: () => api.teams.board(teamKey) });
export const issueQuery = (api: ApiClient, ref: string) => ({ queryKey: wsKey(api, "issue", ref), queryFn: () => api.issues.get(ref) });
export const queueQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "queue", teamKey), queryFn: () => api.teams.queue(teamKey) });

export const useBoard = (teamKey: string) => useQuery(boardQuery(useServices().api, teamKey));

/** The map, and what is read from it (decisions, glossary); and the activity feed. */
export const graphQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "graph", teamKey), queryFn: () => api.map.graph(teamKey) });
export const activityQuery = (api: ApiClient, teamKey: string, who?: "agent" | "human") => ({
  queryKey: wsKey(api, "activity", teamKey, who ?? "all"),
  queryFn: () => api.map.activity(teamKey, who),
});
export const useGraph = (teamKey: string) => useQuery(graphQuery(useServices().api, teamKey));

/** The docs page (the tree and its side panels), one doc, the repositories, the Connect GitHub card and the onboarding wizard. */
export const docsQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "docs", teamKey), queryFn: () => api.docs.index(teamKey) });
export const docQuery = (api: ApiClient, teamKey: string, ref: string) => ({ queryKey: wsKey(api, "doc", teamKey, ref), queryFn: () => api.docs.get(teamKey, ref) });
/** The drawings grid (no scene bodies) and one drawing. */
export const drawingsQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "drawings", teamKey), queryFn: () => api.drawings.list(teamKey) });
export const useDrawings = (teamKey: string) => useQuery(drawingsQuery(useServices().api, teamKey));
export const reposQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "repos", teamKey), queryFn: () => api.repos.list(teamKey) });
export const githubQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "github", teamKey), queryFn: () => api.repos.github(teamKey) });
export const onboardingQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "onboarding", teamKey), queryFn: () => api.onboarding.page(teamKey) });
export const useDocs = (teamKey: string) => useQuery(docsQuery(useServices().api, teamKey));
export const useRepos = (teamKey: string) => useQuery(reposQuery(useServices().api, teamKey));

/** A team's statuses as its settings list them: role, default, colour and issue count. */
export const statusesQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "statuses", teamKey), queryFn: () => api.statuses.list(teamKey) });
export const useStatuses = (teamKey: string) => useQuery(statusesQuery(useServices().api, teamKey));

/** A team's cycles (WH-117): the list by when they are, and one with its issues and what landed. */
export const cyclesQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "cycles", teamKey), queryFn: () => api.cycles.list(teamKey) });
export const cycleQuery = (api: ApiClient, teamKey: string, number: number) => ({ queryKey: wsKey(api, "cycle", teamKey, number), queryFn: () => api.cycles.get(teamKey, number) });
export const useCycles = (teamKey: string) => useQuery(cyclesQuery(useServices().api, teamKey));
export const useCycle = (teamKey: string, number: number) => useQuery(cycleQuery(useServices().api, teamKey, number));

/** Projects (WH-118): the list the person can see, and one project with its milestones and teams. */
export const projectsQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "projects"), queryFn: () => api.projects.list() });
export const projectQuery = (api: ApiClient, id: string) => ({ queryKey: wsKey(api, "project", id), queryFn: () => api.projects.get(id) });
export const useProjects = () => useQuery(projectsQuery(useServices().api));
export const useProject = (id: string) => useQuery(projectQuery(useServices().api, id));

/** Ideas (WH-109): the workspace's, newest first, and one with its comments. */
export const ideasQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "ideas"), queryFn: () => api.ideas.list() });
export const ideaQuery = (api: ApiClient, id: string) => ({ queryKey: wsKey(api, "idea", id), queryFn: () => api.ideas.get(id) });
export const useIdeas = () => useQuery(ideasQuery(useServices().api));
export const useIdea = (id: string) => useQuery(ideaQuery(useServices().api, id));

/** Initiatives (WH-119): every one in the workspace as a flat list in tree order, and one with its sub-initiatives and projects. */
export const initiativesQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "initiatives"), queryFn: () => api.initiatives.list() });
export const initiativeQuery = (api: ApiClient, id: string) => ({ queryKey: wsKey(api, "initiative", id), queryFn: () => api.initiatives.get(id) });
export const useInitiatives = () => useQuery(initiativesQuery(useServices().api));
export const useInitiative = (id: string) => useQuery(initiativeQuery(useServices().api, id));

/** Who is in a team, the people who could still be added, and the workspace-level views of access (ADR-23). */
export const teamMembersQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "members", teamKey), queryFn: () => api.teams.members(teamKey) });
export const addableMembersQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "members", teamKey, "addable"), queryFn: () => api.teams.addableMembers(teamKey) });
export const workspaceTeamsQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "access", "teams"), queryFn: () => api.access.teams() });
export const auditQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "access", "audit"), queryFn: () => api.access.audit({ limit: 50 }) });
/** Team settings: the parent and children, and whether leave, retire and delete are allowed (with the reason when not). Under "members" so a membership change refreshes it. */
export const teamSettingsQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "members", teamKey, "settings"), queryFn: () => api.teams.settings(teamKey) });
export const useTeamSettings = (teamKey: string) => useQuery(teamSettingsQuery(useServices().api, teamKey));
export const useTeamMembers = (teamKey: string) => useQuery(teamMembersQuery(useServices().api, teamKey));

/** The person's machines (the agent daemon), an issue's runs on them, and one run's progress. Under "issue" so an issue change refreshes its runs. */
export const devicesQuery = (api: ApiClient) => ({ queryKey: ["devices"] as const, queryFn: () => api.devices.list() });
export const issueRunsQuery = (api: ApiClient, ref: string) => ({ queryKey: wsKey(api, "issue", ref, "runs"), queryFn: () => api.runs.forIssue(ref) });
export const issuePlanQuery = (api: ApiClient, ref: string, agent: string) => ({ queryKey: wsKey(api, "issue", ref, "plan", agent), queryFn: () => api.runs.plan(ref, agent || undefined) });
export const runBranchesQuery = (api: ApiClient, ref: string, repositoryId: string) => ({
  queryKey: wsKey(api, "run-branches", ref, repositoryId),
  queryFn: () => api.runs.branches(ref, repositoryId),
  staleTime: 60_000,
});
export const runEventsQuery = (api: ApiClient, id: string) => ({ queryKey: wsKey(api, "run", id), queryFn: () => api.runs.events(id) });
export const runDefaultsQuery = (api: ApiClient) => ({ queryKey: ["run-defaults"] as const, queryFn: () => api.devices.runDefaults() });
export const useDevices = () => useQuery(devicesQuery(useServices().api));

/** Chat with the codebase: the person's threads, one thread with its messages, and what a new chat can use. Threads share the "chats" key so the live signal refreshes them all. */
export const chatsQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "chats"), queryFn: () => api.chats.list() });
export const chatQuery = (api: ApiClient, id: string) => ({ queryKey: wsKey(api, "chats", id), queryFn: () => api.chats.get(id) });
export const chatOptionsQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "chat-options", teamKey), queryFn: () => api.chats.options(teamKey) });
export const useChats = () => useQuery(chatsQuery(useServices().api));

/** Agents (docs/agents-plan.md): the catalog and the workspace's own, the guardrails, a catalog agent's versions, and a team's roster. */
export const agentsQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "agents"), queryFn: () => api.agents.list() });
export const guardrailsQuery = (api: ApiClient) => ({ queryKey: wsKey(api, "agents", "guardrails"), queryFn: () => api.agents.guardrails() });
export const agentVersionsQuery = (api: ApiClient, slug: string) => ({ queryKey: wsKey(api, "agents", "versions", slug), queryFn: () => api.agents.versions(slug) });
export const teamAgentsQuery = (api: ApiClient, teamKey: string) => ({ queryKey: wsKey(api, "agents", "team", teamKey), queryFn: () => api.teams.agents(teamKey) });
export const useAgents = () => useQuery(agentsQuery(useServices().api));
