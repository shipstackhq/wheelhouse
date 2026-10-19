import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "@wheelhouse/api-client";
import { NotFound } from "../routes/errors";
import { PageSkeleton } from "./skeleton";

/** Why a read failed, in words for a person. */
export function errorText(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Cannot reach Wheelhouse. Check your connection.";
  return "Something went wrong.";
}

/**
 * A page that reads one thing: a skeleton while it loads, "not found" for a 404 (a workspace or record that is not here or is not yours,
 * which look the same), a message with Try again for any other failure, and the page when the data is there.
 */
export function Loaded<T>({ query, label, rows, children }: { query: UseQueryResult<T>; label: string; rows?: number; children: (data: T) => React.ReactNode }) {
  if (query.isPending) return <PageSkeleton label={label} rows={rows} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) return <NotFound />;
    return (
      <div className="mx-auto max-w-3xl px-6 py-10" role="alert">
        <p className="text-sm text-danger">{errorText(query.error)}</p>
        <button type="button" className="btn mt-3" onClick={() => void query.refetch()}>Try again</button>
      </div>
    );
  }
  return <>{children(query.data)}</>;
}
