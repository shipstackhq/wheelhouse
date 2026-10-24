# @wheelhouse/api

The NestJS API (WH-91, part of the Next.js to NestJS + React migration, WH-87 / ADR-16). It serves, at the same paths as the Next app:

| Route | |
|---|---|
| `POST /mcp` | Model Context Protocol, stateless JSON-RPC (`GET` and `DELETE` answer 405) |
| `GET /api/v1`, `POST /api/v1/:tool` | REST over the same tools |
| `GET /api/health` | liveness and database check |
| `POST /api/webhooks/github` | GitHub's webhook: signature over the raw body, then the delivery (WH-20) |
| `GET /api/github/install`, `GET /api/github/callback` | connecting GitHub for a team: owners only, a signed state and a cookie (ADR-12) |
| `GET /api/stream`, `GET /api/teams/:key/stream` | server-sent events for the signed-in workspace or one team (WH-1) |

| `GET /api/app/auth/options`, `POST /api/app/auth/login`, `/signup`, `/logout`, `GET /api/app/me`, `GET /api/app/teams` | the web app's own API (WH-93); the rest follows in WH-95 to WH-98 |

`/api/app/*` is **new surface, used only by the React app** (conventions, CSRF and the inventory of the 59 server actions it replaces: `docs/ui-api.md`; typed client: `@wheelhouse/api-client`). Every controller there uses `@AppEndpoints()` (CSRF check and the error envelope) and `@UseGuards(SessionGuard)` for signed-in routes.

## Run

```bash
pnpm --filter @wheelhouse/api start      # PORT (default 3000), HOST (default 0.0.0.0)
pnpm --filter @wheelhouse/api dev        # restarts on change
```

The environment is the Next app's: `DATABASE_URL` (a real Postgres) or, without it, an embedded PGlite database in `.data/pglite` at the repository root (override with `PGLITE_DIR`). `.env.local` and `.env` at the repository root are read first; variables already set win. Migrations run at startup. `SIGTERM` closes the database cleanly.

## How it is built

- The code is organised as NestJS modules, one per area (`src/modules/<area>`: daemon, teams, docs, issues, map, github, auth, dashboard), over a platform layer (`src/platform`: config, database, events, streams, storage) and shared plumbing (`src/common`). A module owns its tables, reaches the others only through their `index.ts` (an ESLint error otherwise), and has a service that is the one door to it. `docs/nest-architecture.md` is the decision record and the status of the migration. What is left in `src/lib` is the MCP and v1 tool layer (`tools.ts`, `mcp.ts`, `prompts.ts`, `service.ts`), the agent queue, images and a few helpers.
- Controllers only read the request and write the response; none touches the database, and the isolation audit fails if one does. A route that takes a body declares a DTO (a Zod schema in the module's `dto/` folder) with `@JsonBody(new ZodValidationPipe(schema))`; the lenient fields in `common/pipes/lenient.ts` keep today's behaviour of leaving the judging to the service.
- ESM, started with `tsx`, no build step yet. `tsx` does not emit decorator metadata, so every injected dependency uses an explicit `@Inject(...)`.
- Request bodies are read as text by `http/raw-text.ts` and parsed in the handler, so authentication is judged before the body is, and the webhook signature is checked over exactly the bytes GitHub signed.
- Routes that are for people in a browser (`/api/github/*`) use `HumanGuard`: a `wh_session` cookie, otherwise a 307 to `/login`. Redirects are relative paths.
- Live streams never end on their own, and Nest's shutdown waits for open connections, so `StreamRegistry` ends every open stream before shutdown starts. Without it a SIGTERM during a deploy would hang until the process was killed.

## Test

`pnpm --filter @wheelhouse/api test` for the unit tests. The behaviour is checked by the contract suite from the repository root:

```bash
pnpm test:contract --server-cmd "pnpm --filter @wheelhouse/api start"                  # the frozen contract, both passes
pnpm test:contract --suite app --server-cmd "pnpm --filter @wheelhouse/api start"      # the web app's API (/api/app)
```
