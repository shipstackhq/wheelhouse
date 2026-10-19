# @wheelhouse/api-client

A typed client for the web app's API (`/api/app/*`, WH-93). Only `fetch`; works in the browser and in tests.

```ts
import { createApiClient, ApiError } from "@wheelhouse/api-client";

const api = createApiClient();            // same origin; pass { baseUrl, fetch } otherwise
const me = await api.me();                // null when signed out
try {
  await api.auth.login({ email, password });
} catch (e) {
  if (e instanceof ApiError && e.fields) showFieldErrors(e.fields);
}
const teams = await api.teams.list();
```

It sends the CSRF token on every state-changing request and refreshes it once if the server says it went stale; every failure is an `ApiError` (`status`, `code`, `message`, `fields`, `current` for conflicts, `retryAfter`). Conventions: `docs/ui-api.md`. Add a method here with each new endpoint.
