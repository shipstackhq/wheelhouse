import { useCallback } from "react";
import { Link as RouterLink, useLocation, NavLink as RouterNavLink, useNavigate as useRouterNavigate, useParams, type LinkProps, type NavLinkProps, type NavigateOptions, type To } from "react-router";
import type { ApiClient } from "@wheelhouse/api-client";

/**
 * Pages that belong to a workspace live under /w/:slug. Code writes their paths as ever (`/t/WH`, `/inbox`) and these wrappers
 * add the prefix, so no page needs to know about it. Person pages (and paths already prefixed) stay as written.
 */
const OUTSIDE = /^\/(w(?=\/)|login|signup|invite|offline|settings(?=[?#]|$)|settings\/(profile|password|devices))(?=[/?#]|$)/;

/** A query key that starts with the workspace, so two workspaces never share a cache entry. */
export const wsKey = <T extends unknown[]>(api: ApiClient, ...rest: T) => [api.getWorkspace(), ...rest] as const;

/** The path with the workspace in it, for those that need one (not person pages, not paths already prefixed). */
export const wsPathFor = (slug: string | undefined, to: To): To => (slug && typeof to === "string" && to.startsWith("/") && !OUTSIDE.test(to) ? `/w/${slug}${to === "/" ? "" : to}` : to);

/** The workspace in the address. */
export const useWorkspaceSlug = () => useParams().slug;

/** Where this page is within the workspace (`/t/WH`, `/inbox`), whatever the workspace. */
export const useWsPathname = () => useLocation().pathname.replace(/^\/w\/[^/]+/, "") || "/";

/** Turns a path written without the workspace into one with it. */
export function useWsPath() {
  const slug = useWorkspaceSlug();
  return useCallback((to: To) => wsPathFor(slug, to), [slug]);
}

export function Link({ to, ...props }: LinkProps) {
  return <RouterLink to={useWsPath()(to)} {...props} />;
}

export function NavLink({ to, ...props }: NavLinkProps) {
  return <RouterNavLink to={useWsPath()(to)} {...props} />;
}

export function useNavigate() {
  const navigate = useRouterNavigate();
  const wsPath = useWsPath();
  return useCallback((to: To | number, options?: NavigateOptions) => (typeof to === "number" ? navigate(to) : navigate(wsPath(to), options)), [navigate, wsPath]);
}
