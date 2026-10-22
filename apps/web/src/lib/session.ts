import { useQuery } from "@tanstack/react-query";
import type { ApiClient, Me, Team } from "@wheelhouse/api-client";
import { useServices } from "./services";

/** Who is signed in: the person, or null when signed out. Read by the route guards and by the shell. */
export const meQuery = (api: ApiClient) => ({ queryKey: ["me"] as const, queryFn: (): Promise<Me | null> => api.me(), staleTime: 30_000 });

/** The workspace's teams: the sidebar's switcher and the team pages' headers. */
export const teamsQuery = (api: ApiClient) => ({ queryKey: ["teams"] as const, queryFn: (): Promise<Team[]> => api.teams.list() });

export function useMe() {
  const { api } = useServices();
  return useQuery(meQuery(api));
}

export function useTeams() {
  const { api } = useServices();
  return useQuery(teamsQuery(api));
}
