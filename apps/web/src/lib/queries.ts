import { useQuery } from "@tanstack/react-query";
import type { ApiClient, DashboardWidgets } from "@wheelhouse/api-client";
import { useDashboardProject } from "./dashboard-scope";
import { useServices } from "./services";

/** What each page reads. Keys are grouped (team, agents, invites, admin, dashboard) so a change can refresh a whole group. */
export const teamQuery = (api: ApiClient) => ({ queryKey: ["team"] as const, queryFn: () => api.team.overview() });
export const agentsQuery = (api: ApiClient) => ({ queryKey: ["agents"] as const, queryFn: () => api.agents.page() });
export const invitesQuery = (api: ApiClient, kind: "join_team" | "new_team") => ({ queryKey: ["invites", kind] as const, queryFn: () => api.invites.list(kind) });
export const adminTeamsQuery = (api: ApiClient) => ({ queryKey: ["admin", "teams"] as const, queryFn: () => api.admin.teams() });
export const adminTeamQuery = (api: ApiClient, id: string) => ({ queryKey: ["admin", "team", id] as const, queryFn: () => api.admin.team(id) });
export const widgetQuery = <W extends keyof DashboardWidgets>(api: ApiClient, widget: W, project: string | null = null) => ({
  queryKey: ["dashboard", widget, project ?? "*"] as const,
  queryFn: () => api.dashboard.widget(widget, project ?? undefined),
});

export const useTeam = () => useQuery(teamQuery(useServices().api));
export const useAgentsPage = () => useQuery(agentsQuery(useServices().api));
export const useInvites = (kind: "join_team" | "new_team") => useQuery(invitesQuery(useServices().api, kind));
export const useAdminTeams = () => useQuery(adminTeamsQuery(useServices().api));
export const useAdminTeam = (id: string) => useQuery(adminTeamQuery(useServices().api, id));
/** A widget's data, for the workspace or, inside a project's Overview, for that project (see lib/dashboard-scope). */
export const useWidget = <W extends keyof DashboardWidgets>(widget: W) => useQuery(widgetQuery(useServices().api, widget, useDashboardProject()));

/** The project page and its ticket dialog. Grouped under "board", "ticket" and "queue" so a change refreshes the right ones. */
export const boardQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["board", projectKey] as const, queryFn: () => api.projects.board(projectKey) });
export const ticketQuery = (api: ApiClient, ref: string) => ({ queryKey: ["ticket", ref] as const, queryFn: () => api.tickets.get(ref) });
export const queueQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["queue", projectKey] as const, queryFn: () => api.projects.queue(projectKey) });

export const useBoard = (projectKey: string) => useQuery(boardQuery(useServices().api, projectKey));

/** The map, and what is read from it (decisions, glossary); and the activity feed. */
export const graphQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["graph", projectKey] as const, queryFn: () => api.map.graph(projectKey) });
export const activityQuery = (api: ApiClient, projectKey: string, who?: "agent" | "human") => ({
  queryKey: ["activity", projectKey, who ?? "all"] as const,
  queryFn: () => api.map.activity(projectKey, who),
});
export const useGraph = (projectKey: string) => useQuery(graphQuery(useServices().api, projectKey));

/** The docs page (the tree and its side panels), one doc, the repositories, the Connect GitHub card and the onboarding wizard. */
export const docsQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["docs", projectKey] as const, queryFn: () => api.docs.index(projectKey) });
export const docQuery = (api: ApiClient, projectKey: string, ref: string) => ({ queryKey: ["doc", projectKey, ref] as const, queryFn: () => api.docs.get(projectKey, ref) });
export const reposQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["repos", projectKey] as const, queryFn: () => api.repos.list(projectKey) });
export const githubQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["github", projectKey] as const, queryFn: () => api.repos.github(projectKey) });
export const onboardingQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["onboarding", projectKey] as const, queryFn: () => api.onboarding.page(projectKey) });
export const useDocs = (projectKey: string) => useQuery(docsQuery(useServices().api, projectKey));
export const useRepos = (projectKey: string) => useQuery(reposQuery(useServices().api, projectKey));

/** Who is in a project, the people who could still be added, and the workspace-level views of access (ADR-23). */
export const projectMembersQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["members", projectKey] as const, queryFn: () => api.projects.members(projectKey) });
export const addableMembersQuery = (api: ApiClient, projectKey: string) => ({ queryKey: ["members", projectKey, "addable"] as const, queryFn: () => api.projects.addableMembers(projectKey) });
export const workspaceProjectsQuery = (api: ApiClient) => ({ queryKey: ["access", "projects"] as const, queryFn: () => api.access.projects() });
export const auditQuery = (api: ApiClient) => ({ queryKey: ["access", "audit"] as const, queryFn: () => api.access.audit({ limit: 50 }) });
export const useProjectMembers = (projectKey: string) => useQuery(projectMembersQuery(useServices().api, projectKey));
