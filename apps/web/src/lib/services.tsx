import { createContext, useContext, type ReactNode } from "react";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, createApiClient, type ApiClient } from "@wheelhouse/api-client";

/**
 * What the app is built from: the API client and the query cache. Passed in (not module globals) so that tests, and
 * later the route loaders, can run against a fake server.
 */
export type Services = { api: ApiClient; queryClient: QueryClient };

/**
 * `onSignedOut` runs when any request learns the session has ended (a 401 from the API). Before it, the cache is told nobody is
 * signed in (otherwise the sign-in page would see a cached person and send them straight back); after it, everything the
 * previous person's session loaded is dropped, so the next person to sign in on this browser never sees it.
 */
export function createServices(opts: { api?: ApiClient; onSignedOut?: () => void } = {}): Services {
  const api = opts.api ?? createApiClient();
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!(error instanceof ApiError && error.isSignedOut) || query.queryKey[0] === "me") return;
        queryClient.setQueryData(["me"], null);
        opts.onSignedOut?.();
        setTimeout(() => queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" }), 0);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        // A refusal (4xx) will not change by asking again; a server hiccup or a dropped connection might.
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      },
    },
  });
  return { api, queryClient };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return (
    <ServicesContext.Provider value={services}>
      <QueryClientProvider client={services.queryClient}>{children}</QueryClientProvider>
    </ServicesContext.Provider>
  );
}

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("useServices must be used inside <ServicesProvider>");
  return s;
}
