import { useQuery } from "@tanstack/react-query";
import type { ApiClient, DashboardWidgets } from "@wheelhouse/api-client";
import { useDashboardTeam } from "./dashboard-scope";
import { useServices } from "./services";

/** What each page reads. Keys are grouped (workspace, agents, invites, admin, dashboard) so a change can refresh a whole group. */
export const workspaceQuery = (api: ApiClient) => ({ queryKey: ["workspace"] as const, queryFn: () => api.workspace.overview() });
export const agentsQuery = (api: ApiClient) => ({ queryKey: ["agents"] as const, queryFn: () => api.agents.page() });
export const invitesQuery = (api: ApiClient, kind: "join_workspace" | "new_workspace") => ({ queryKey: ["invites", kind] as const, queryFn: () => api.invites.list(kind) });
export const adminWorkspacesQuery = (api: ApiClient) => ({ queryKey: ["admin", "workspaces"] as const, queryFn: () => api.admin.workspaces() });
export const adminWorkspaceQuery = (api: ApiClient, id: string) => ({ queryKey: ["admin", "workspace", id] as const, queryFn: () => api.admin.workspace(id) });
export const widgetQuery = <W extends keyof DashboardWidgets>(api: ApiClient, widget: W, team: string | null = null) => ({
  queryKey: ["dashboard", widget, team ?? "*"] as const,
  queryFn: () => api.dashboard.widget(widget, team ?? undefined),
});

export const useWorkspace = () => useQuery(workspaceQuery(useServices().api));
export const useAgentsPage = () => useQuery(agentsQuery(useServices().api));
export const useInvites = (kind: "join_workspace" | "new_workspace") => useQuery(invitesQuery(useServices().api, kind));
export const useAdminWorkspaces = () => useQuery(adminWorkspacesQuery(useServices().api));
export const useAdminWorkspace = (id: string) => useQuery(adminWorkspaceQuery(useServices().api, id));
/** A widget's data, for the workspace or, inside a team's Overview, for that team (see lib/dashboard-scope). */
export const useWidget = <W extends keyof DashboardWidgets>(widget: W) => useQuery(widgetQuery(useServices().api, widget, useDashboardTeam()));

/** The team page and its issue dialog. Grouped under "board", "issue" and "queue" so a change refreshes the right ones. */
export const boardQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["board", teamKey] as const, queryFn: () => api.teams.board(teamKey) });
export const issueQuery = (api: ApiClient, ref: string) => ({ queryKey: ["issue", ref] as const, queryFn: () => api.issues.get(ref) });
export const queueQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["queue", teamKey] as const, queryFn: () => api.teams.queue(teamKey) });

export const useBoard = (teamKey: string) => useQuery(boardQuery(useServices().api, teamKey));

/** The map, and what is read from it (decisions, glossary); and the activity feed. */
export const graphQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["graph", teamKey] as const, queryFn: () => api.map.graph(teamKey) });
export const activityQuery = (api: ApiClient, teamKey: string, who?: "agent" | "human") => ({
  queryKey: ["activity", teamKey, who ?? "all"] as const,
  queryFn: () => api.map.activity(teamKey, who),
});
export const useGraph = (teamKey: string) => useQuery(graphQuery(useServices().api, teamKey));

/** The docs page (the tree and its side panels), one doc, the repositories, the Connect GitHub card and the onboarding wizard. */
export const docsQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["docs", teamKey] as const, queryFn: () => api.docs.index(teamKey) });
export const docQuery = (api: ApiClient, teamKey: string, ref: string) => ({ queryKey: ["doc", teamKey, ref] as const, queryFn: () => api.docs.get(teamKey, ref) });
export const reposQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["repos", teamKey] as const, queryFn: () => api.repos.list(teamKey) });
export const githubQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["github", teamKey] as const, queryFn: () => api.repos.github(teamKey) });
export const onboardingQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["onboarding", teamKey] as const, queryFn: () => api.onboarding.page(teamKey) });
export const useDocs = (teamKey: string) => useQuery(docsQuery(useServices().api, teamKey));
export const useRepos = (teamKey: string) => useQuery(reposQuery(useServices().api, teamKey));

/** A team's statuses as its settings list them: role, default, colour and issue count. */
export const statusesQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["statuses", teamKey] as const, queryFn: () => api.statuses.list(teamKey) });
export const useStatuses = (teamKey: string) => useQuery(statusesQuery(useServices().api, teamKey));

/** A team's cycles (WH-117): the list by when they are, and one with its issues and what landed. */
export const cyclesQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["cycles", teamKey] as const, queryFn: () => api.cycles.list(teamKey) });
export const cycleQuery = (api: ApiClient, teamKey: string, number: number) => ({ queryKey: ["cycle", teamKey, number] as const, queryFn: () => api.cycles.get(teamKey, number) });
export const useCycles = (teamKey: string) => useQuery(cyclesQuery(useServices().api, teamKey));
export const useCycle = (teamKey: string, number: number) => useQuery(cycleQuery(useServices().api, teamKey, number));

/** Projects (WH-118): the list the person can see, and one project with its milestones and teams. */
export const projectsQuery = (api: ApiClient) => ({ queryKey: ["projects"] as const, queryFn: () => api.projects.list() });
export const projectQuery = (api: ApiClient, id: string) => ({ queryKey: ["project", id] as const, queryFn: () => api.projects.get(id) });
export const useProjects = () => useQuery(projectsQuery(useServices().api));
export const useProject = (id: string) => useQuery(projectQuery(useServices().api, id));

/** Initiatives (WH-119): every one in the workspace as a flat list in tree order, and one with its sub-initiatives and projects. */
export const initiativesQuery = (api: ApiClient) => ({ queryKey: ["initiatives"] as const, queryFn: () => api.initiatives.list() });
export const initiativeQuery = (api: ApiClient, id: string) => ({ queryKey: ["initiative", id] as const, queryFn: () => api.initiatives.get(id) });
export const useInitiatives = () => useQuery(initiativesQuery(useServices().api));
export const useInitiative = (id: string) => useQuery(initiativeQuery(useServices().api, id));

/** Who is in a team, the people who could still be added, and the workspace-level views of access (ADR-23). */
export const teamMembersQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["members", teamKey] as const, queryFn: () => api.teams.members(teamKey) });
export const addableMembersQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["members", teamKey, "addable"] as const, queryFn: () => api.teams.addableMembers(teamKey) });
export const workspaceTeamsQuery = (api: ApiClient) => ({ queryKey: ["access", "teams"] as const, queryFn: () => api.access.teams() });
export const auditQuery = (api: ApiClient) => ({ queryKey: ["access", "audit"] as const, queryFn: () => api.access.audit({ limit: 50 }) });
/** Team settings: the parent and children, and whether leave, retire and delete are allowed (with the reason when not). Under "members" so a membership change refreshes it. */
export const teamSettingsQuery = (api: ApiClient, teamKey: string) => ({ queryKey: ["members", teamKey, "settings"] as const, queryFn: () => api.teams.settings(teamKey) });
export const useTeamSettings = (teamKey: string) => useQuery(teamSettingsQuery(useServices().api, teamKey));
export const useTeamMembers = (teamKey: string) => useQuery(teamMembersQuery(useServices().api, teamKey));

/** The person's machines (the agent daemon), an issue's runs on them, and one run's progress. Under "issue" so an issue change refreshes its runs. */
export const devicesQuery = (api: ApiClient) => ({ queryKey: ["devices"] as const, queryFn: () => api.devices.list() });
export const issueRunsQuery = (api: ApiClient, ref: string) => ({ queryKey: ["issue", ref, "runs"] as const, queryFn: () => api.runs.forIssue(ref) });
export const runBranchesQuery = (api: ApiClient, ref: string, repositoryId: string) => ({
  queryKey: ["run-branches", ref, repositoryId] as const,
  queryFn: () => api.runs.branches(ref, repositoryId),
  staleTime: 60_000,
});
export const runEventsQuery = (api: ApiClient, id: string) => ({ queryKey: ["run", id] as const, queryFn: () => api.runs.events(id) });
export const useDevices = () => useQuery(devicesQuery(useServices().api));
