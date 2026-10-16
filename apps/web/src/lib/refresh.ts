import type { QueryClient } from "@tanstack/react-query";

/** After a change this browser made, read again whatever may show it. Who is signed in does not change that way. */
export const refreshAll = (queryClient: QueryClient) => queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
