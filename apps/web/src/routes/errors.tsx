import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { ApiError } from "@wheelhouse/api-client";

/** The page for a URL that is not here, or a team that is not this workspace's (the two look the same, by design). */
export function NotFound() {
  return (
    <main className="flex h-full min-h-60 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="not-found">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="max-w-sm text-sm text-muted">There is nothing at this address, or it belongs to another workspace.</p>
      <Link to="/" className="btn mt-2">Go home</Link>
    </main>
  );
}

/** What a route shows when it throws: a loader that failed, a render error, a server that cannot be reached. */
export function RouteError() {
  const error = useRouteError();
  let title = "Something went wrong";
  let detail = "Reload the page and try again. If it keeps happening, tell your team.";
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page not found" : `Error ${error.status}`;
    detail = error.statusText || detail;
  } else if (error instanceof ApiError) {
    title = error.status >= 500 ? "Wheelhouse had a problem" : "That did not work";
    detail = error.message;
  } else if (error instanceof TypeError) {
    title = "Cannot reach Wheelhouse";
    detail = "Check your connection, then reload.";
  } else if (error instanceof Error && import.meta.env.DEV) {
    detail = error.message;
  }
  return (
    <main role="alert" className="flex min-h-dvh flex-col items-center justify-center gap-2 p-6 text-center" data-testid="route-error">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="max-w-sm text-sm text-muted">{detail}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
        <a href="/" className="btn">Go home</a>
      </div>
    </main>
  );
}
