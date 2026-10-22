import { redirect, type LoaderFunction } from "react-router";
import { ApiError } from "@wheelhouse/api-client";
import { meQuery, teamsQuery } from "../lib/session";
import type { Services } from "../lib/services";

/**
 * The auth gate. These run before a route renders, so a signed-out visitor is redirected before any of the shell is drawn,
 * and the shell never flashes. They read through the query cache, so moving between pages does not ask again.
 */

/** Everything inside the app shell needs a signed-in person; the sidebar needs their teams. */
export const requireSignedIn =
  ({ api, queryClient }: Services): LoaderFunction =>
  async () => {
    // Gating the first screen fails fast: no retries, so a dropped connection shows the error page (with Reload) at once.
    const me = await queryClient.fetchQuery({ ...meQuery(api), retry: false });
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
  };

/** Sign-in and sign-up are for people who are signed out; a signed-in person is sent home (as the Next app does). */
export const redirectIfSignedIn =
  ({ api, queryClient }: Services): LoaderFunction =>
  async () => {
    if (await queryClient.fetchQuery({ ...meQuery(api), retry: false })) throw redirect("/");
    return null;
  };
