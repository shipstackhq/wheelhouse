import { redirect, type LoaderFunction } from "react-router";
import { ApiError, type Me } from "@wheelhouse/api-client";
import { meQuery, teamsQuery } from "../lib/session";
import type { Services } from "../lib/services";

/**
 * The auth gate. These run before a route renders, so a signed-out visitor is redirected before any of the shell is drawn,
 * and the shell never flashes. They read through the query cache, so moving between pages does not ask again.
 */

/** Everything inside the app shell needs a signed-in person; the sidebar needs their teams. */
export const requireSignedIn = (services: Services): LoaderFunction => async () => gate(services);

async function gate({ api, queryClient }: Services, freshMe = false) {
  // Gating the first screen fails fast: no retries, so a dropped connection shows the error page (with Reload) at once.
  const me = await queryClient.fetchQuery({ ...meQuery(api), retry: false, ...(freshMe && { staleTime: 0 }) });
  if (!me) throw redirect("/login");
  try {
    await queryClient.fetchQuery({ ...teamsQuery(api), retry: false });
  } catch (e) {
    if (e instanceof ApiError && e.isSignedOut) {
      queryClient.setQueryData(meQuery(api).queryKey, null);
      throw redirect("/login");
    }
    throw e;
  }
  return null;
}

/**
 * The same gate for a workspace's pages (/w/:slug): the workspace is set on the API client first, so everything after asks for it, and
 * the person is read again when they come from another workspace. A workspace they are not in is a 404, as the API says.
 */
export const requireWorkspace =
  (services: Services): LoaderFunction =>
  async ({ params }) => {
    const { api, queryClient } = services;
    api.setWorkspace(params.slug!);
    try {
      return await gate(services, queryClient.getQueryData<Me | null>(meQuery(api).queryKey)?.workspace.slug !== params.slug);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new Response(null, { status: 404 });
      throw e;
    }
  };

/** `/` goes to the workspace this person last used. */
export const redirectToWorkspace =
  ({ api, queryClient }: Services): LoaderFunction =>
  async () => {
    api.setWorkspace(null);
    const me = await queryClient.fetchQuery({
      ...meQuery(api),
      retry: false,
      staleTime: 0,
    });
    throw redirect(me ? `/w/${me.workspace.slug}` : "/login");
  };

/** Sign-in and sign-up are for people who are signed out; a signed-in person is sent home (as the Next app does). */
export const redirectIfSignedIn =
  ({ api, queryClient }: Services): LoaderFunction =>
  async () => {
    if (await queryClient.fetchQuery({ ...meQuery(api), retry: false }))
      throw redirect("/");
    return null;
  };
