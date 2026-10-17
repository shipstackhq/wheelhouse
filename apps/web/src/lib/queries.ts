import { useQuery } from "@tanstack/react-query";
import type { ApiClient, DashboardWidgets } from "@wheelhouse/api-client";
import { useServices } from "./services";

/** What each page reads. Keys are grouped (team, agents, invites, admin, dashboard) so a change can refresh a whole group. */
export const teamQuery = (api: ApiClient) => ({ queryKey: ["team"] as const, queryFn: () => api.team.overview() });
export const agentsQuery = (api: ApiClient) => ({ queryKey: ["agents"] as const, queryFn: () => api.agents.page() });
export const invitesQuery = (api: ApiClient, kind: "join_team" | "new_team") => ({ queryKey: ["invites", kind] as const, queryFn: () => api.invites.list(kind) });
export const adminTeamsQuery = (api: ApiClient) => ({ queryKey: ["admin", "teams"] as const, queryFn: () => api.admin.teams() });
export const adminTeamQuery = (api: ApiClient, id: string) => ({ queryKey: ["admin", "team", id] as const, queryFn: () => api.admin.team(id) });
export const widgetQuery = <W extends keyof DashboardWidgets>(api: ApiClient, widget: W) => ({
  queryKey: ["dashboard", widget] as const,
  queryFn: () => api.dashboard.widget(widget),
});

export const useTeam = () => useQuery(teamQuery(useServices().api));
export const useAgentsPage = () => useQuery(agentsQuery(useServices().api));
export const useInvites = (kind: "join_team" | "new_team") => useQuery(invitesQuery(useServices().api, kind));
export const useAdminTeams = () => useQuery(adminTeamsQuery(useServices().api));
export const useAdminTeam = (id: string) => useQuery(adminTeamQuery(useServices().api, id));
export const useWidget = <W extends keyof DashboardWidgets>(widget: W) => useQuery(widgetQuery(useServices().api, widget));

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
