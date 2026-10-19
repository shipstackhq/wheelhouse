import { useQuery } from "@tanstack/react-query";
import type { ApiClient, Me, Project } from "@wheelhouse/api-client";
import { useServices } from "./services";

/** Who is signed in: the person, or null when signed out. Read by the route guards and by the shell. */
export const meQuery = (api: ApiClient) => ({ queryKey: ["me"] as const, queryFn: (): Promise<Me | null> => api.me(), staleTime: 30_000 });

/** The workspace's projects: the sidebar's switcher and the project pages' headers. */
export const projectsQuery = (api: ApiClient) => ({ queryKey: ["projects"] as const, queryFn: (): Promise<Project[]> => api.projects.list() });

export function useMe() {
  const { api } = useServices();
  return useQuery(meQuery(api));
}

export function useProjects() {
  const { api } = useServices();
  return useQuery(projectsQuery(api));
}
