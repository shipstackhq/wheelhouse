# NestJS architecture (ADR)

Status: accepted, 2026-10-23. The layout, the platform layer and the boundary rule are in place, and the former `packages/core` has been folded into `apps/api` (server logic, schema, migrations and tools) and `packages/shared` (the few pure files the web app also uses). What remains is moving `src/lib` into modules, area by area.

## Decision

`apps/api` becomes a native NestJS application: one module per domain area, injectable services, DTOs validated at the edge, one exception filter, guards and decorators. Each module owns its tables and reaches the others only through their exported services, so that any module can later become its own service (a Go one included) without its callers changing shape.

Until a module is migrated, its controllers keep calling the functions in `apps/api/src/lib` directly (strangler pattern). Nothing is rewritten in bulk.

## Layout

```
apps/api/src/
  common/      guards, filters, pipes, interceptors, decorators (no domain knowledge)
  platform/    DatabaseModule (global), ConfigModule (global), EventsModule
  modules/<area>/
    <area>.module.ts
    <area>.controller.ts (one or more)
    <area>.service.ts
    dto/         Zod schemas and their inferred types
    index.ts     the module's public surface: the only file other modules may import
```

`platform/` holds infrastructure every module needs; it wraps what `src/lib` already does (`getDb()`, the environment, `emit`) so those functions keep working unchanged. `common/` holds Nest plumbing that knows nothing about a domain.

## Table ownership

Every table in `apps/api/src/db/schema.ts` has exactly one owner. The first cut was checked against the schema's own comments; the platform and the issues rows below record the decisions on the tables that more than one area touches.

| Module | Tables |
|---|---|
| `daemon` | devices, device_pairings, device_tokens, device_messages, device_jobs, device_job_events, instance_keys |
| `teams` | teams, team_members, statuses, audit_events |
| `issues` | issues, comments, cycles, labels, issue_labels, projects, project_teams, project_milestones, initiatives, initiative_projects; view project_visibility |
| `map` | nodes, edges, flows, decisions, decision_nodes, terms, node_drafts, work_sessions |
| `docs` | docs, doc_nodes, doc_drafts |
| `github` | repositories, team_files, github_installations, github_deliveries, pull_requests, pull_request_issues |
| `auth` | users, sessions, workspaces, memberships, invites, invite_teams, api_keys, api_key_teams |

`instance_keys` sits with `daemon` because it holds the daemon message signing key. `work_sessions` sits with `map` because it drives the "in flux" state of the map; `docs` is its own module because it has its own controllers.

**Decided (2026-10-23):**

- `events`, `workspace_events` and `agent_cursors` belong to `platform/events`. The event log is infrastructure: every module writes it through `EventsService.emit`, and a cursor is a reader's position in it. No domain module reads or writes these tables directly.
- `issue_nodes` (an issue linked to a map node) belongs to `issues`: it is written only from an issue (`linkIssueNode`). The map's graph asks the issues module for the issues attached to a set of nodes and does not join the table itself. The table's foreign keys to `issues` and `nodes` couple the two areas in the database; if the map is ever extracted, that foreign key is the one to drop.

## Rules

1. A module reads and writes only its own tables. For anything else it calls another module's exported service.
2. A module's `index.ts` is its only public surface. No module imports another module's internal files.
3. Cross-module transactions: inside one process, a module may pass a transaction handle to another module's exported service, so one commit covers both. If a module is later split out, that call becomes an API or event call, and the transaction boundary is redesigned at that point, not before.
4. Notifications between modules go through the in-process events module over the existing event log (`EventsService.emit`, which wraps `src/lib`'s `emit`). A module never reads another module's tables to learn that something changed.
5. Controllers parse input through a Zod pipe and call services; they hold no business logic and call no database directly.

## Validation

Zod schemas, applied by a pipe (`common/pipes/zod-validation.pipe.ts`). One schema gives both the TypeScript type and the runtime check. A failure is a `ServiceError("invalid")` with `details.fields`, the shape the app already sends. `zod` is a dependency of `apps/api`, so no new tooling is introduced. No existing route uses the pipe yet.

## Errors and identity

- `common/filters/service-error.filter.ts` renders a `ServiceError` through `src/lib/api-errors`'s `appFailure`, the same mapping every controller uses today. It is not yet registered globally: a controller without its own filter (health, stream, webhook, github) would otherwise change its answer for a `ServiceError`. Registration waits until those controllers have filters.
- `@CurrentActor()` returns the actor the guards set: `req.actor` for API keys and sessions on `/mcp` and `/api/v1`, `req.human.actor` for signed-in people on `/api/app`.

## Service roles

One build, one or several processes. `SERVICE_ROLE` is `api`, `daemon` or `all` (the default); anything else stops the server at boot. The role decides which modules are loaded, never what a module does (`app.imports.ts`, `platform/config/service-role.ts`):

| Role | Serves |
|---|---|
| `api` | people and agents: the legacy group (`/api/app`, `/api/v1`, `/mcp`, GitHub, streams) and the person's side of the daemon module (`/api/app/devices`, runs on an issue) |
| `daemon` | paired machines: `/api/daemon` and the sweep that expires offers and marks quiet devices' jobs unreachable |
| `all` | both, in one process |

`/api/health` and the platform modules are in every role. The sweep runs only where the daemon role runs, so it ticks in one process. Splitting the daemon traffic into its own process is then a deployment choice (`SERVICE_ROLE=daemon`) and not a rewrite. Both processes use the same database; each module still reads and writes only its own tables.

## Migration

Strangler, one area at a time. `daemon` is the pilot. For each area: create the module, move its service and DTOs, switch its controllers to the service, leave the `src/lib` functions in place for the other callers until they are moved too. Routes, responses and the contract suite (`pnpm test:contract`) must not change in any step.

## Boundary enforcement

`eslint.config.mjs` restricts, for files under `apps/api/src/modules/**`, imports of another module's internal files (anything but its `index.ts`). The rule is `no-restricted-imports` at `warn` while the migration runs. It becomes `error` when the last area is migrated.

## Status

- **Daemon pilot, step 1 (done):** `modules/daemon/` has the module (`DaemonModule.register(role)`), `DaemonService` (the module's one door; each method hands over to `src/lib/daemon.ts` for now), the device guard and exception filter, both controllers and the sweep. Every other controller sits in `LegacyApiModule` until its area gets a module. Routes, responses and the contract suite are unchanged.
- **Daemon pilot, step 2 (done):** `lib/daemon.ts` and `lib/daemon-crypto.ts` are now in the module, one file per concern: `device-common` (constants, states), `device-stream` (signed messages and the SSE stream), `pairing`, `device-auth` (tokens), `device-reports` (hello, heartbeat, settling what a machine holds), `job-state` (finding and moving a job's row), `device-jobs` (accept, reject, progress, finish, the pull request, the sweep), `devices` (a person's machines) and `runs` (a person's runs on an issue). `internal.ts` re-exports them for the module's own tests; `index.ts` stays the public surface. `DaemonService` still hands over to these functions; folding them into service methods is optional and can wait.
- **Day 3, `service.ts` split (done):** `lib/service.ts` (2,700 lines) is now a barrel over one file per area, so its 77 importers are unchanged: `service-core` (`emit`, `Tx`/`Q`, `lockRow`, `isUuid`), `service-teams`, `service-issues`, `service-map` (graph, data layer, edges, flows), `service-repositories`, `service-freshness`, `service-decisions` (decisions and glossary), `service-queue` (events, sessions, changes), `service-checklist` and `service-docs`. The functions are unchanged. Next, each file moves into its module (`teams`, `docs`, `issues`, `map`, `github` and `auth` are done; MCP/v1, the request plumbing, the agent queue and the last platform files remain; `service-core` and the events part of `service-queue` go to `platform/`).
- **Teams module (done):** `modules/teams/` has the logic (`teams`, `team-access`, `team-lifecycle`, `team-members`, `team-icon`, `statuses`, with their tests), `TeamsService` (the one door, same pattern as the daemon's), `TeamsModule` (the api role only) and its three controllers (teams, members, statuses). Other modules still import `team-access` directly, which the boundary rule reports as warnings until those areas move.
- **Docs module (done):** `modules/docs/` has the logic (`docs.ts`, the former `service-docs`, and `docs-app.ts`, the web app's doc functions, with the tests), `DocsService`, `DocsModule` (the api role only) and the docs controller. `lib/docs-app.ts` held the repositories, GitHub connect and onboarding functions too; those stay in `lib/repositories-app.ts` for the `github` and `map` areas. `service-freshness` still imports the docs logic directly (a boundary warning until the map module moves).
- **Issues module (done):** `modules/issues/` has the logic (`issues.ts`, the former `service-issues`, `issue-nodes.ts`, `cycles`, `projects`, `initiatives`, `sub-issues`, `board-app` and the `*-app` files, with their tests), `IssuesService`, `IssuesModule` (the api role only) and five controllers (board, issues, cycles, projects, initiatives). `linkIssueNode` moved out of the map code into `issue-nodes.ts`, so `issue_nodes` is written only here, as decided. Still to do for this area: `lib/links.ts` (labels and cycle numbers for issues, node ids for decisions, used by the map and docs too) waits until it can be split between the two owners, the map's graph still reads `issue_nodes` itself, and the issues module imports the map's `resolveNode`. Several other files still import the issues logic directly (boundary warnings).
- **Map module (done):** `modules/map/` has the logic (`graph.ts`, the former `service-map`, `decisions.ts`, `freshness.ts`, `map-app`, `sync` for sessions, landing and drafts, `briefing`, `ask`, with their tests), `MapService`, `MapModule` (the api role only) and the map controller. Left in `lib/` on purpose: `service-repositories` (the `github` area owns `repositories`), `service-queue` (events, cursors and the work-session helpers; it splits between `platform/events` and the map), `service-checklist`, `links.ts` and `metrics.ts`. The map's graph still reads `issue_nodes` itself. Many files still import the map logic directly (boundary warnings).
- **Github module (done):** `modules/github/` has all of the former `lib/github/` (API client, connect flow, webhook, state, signature, refs, PR rules, runtime, config, service, with their tests), `repositories.ts` (the former `service-repositories`) and `repositories-app.ts`, `GithubService`, `GithubModule` (the api role only) and three controllers (connect, webhook, repositories). `repositories-app.ts` still carries the onboarding and first-concept functions, which belong to the map and wait for a later cut. The daemon module still imports the GitHub API client directly (boundary warnings).
- **Auth module (done):** `common/actor.ts` now holds the `Actor` type, which every module uses. `modules/auth/` has the logic (`access` for sessions and API keys, `accounts`, `auth-core`, `auth-policy`, `invites`, `key-scope`, `members`, `workspace-app`, `workspace-slug`, `workspaces-admin`, the sign-in helpers `begin` and `me`, with their tests), `AuthService`, `AuthModule` (the api role only) and six controllers (auth, me, workspace, invites, keys, admin). Deliberately not in the module: the guards and request plumbing (`auth/`, `web/endpoints`, `csrf`, `session-cookie`, `origin`, `body`), images and storage, `rate-limit`, `web-input`, `api-errors`, metrics and the dashboard; Nest's own composition (guards, interceptors, global providers) is where those go, not into a domain module. Many files import `auth-core` and `access` directly (boundary warnings).
- **Platform and common (partly done):** `common/` now holds `actor`, `rate-limit`, `service-error` and `uuid`. `platform/events/` holds the event bus, `emit` (with `diff`) and `EventsService`, which wraps `emit` directly. `platform/database/transaction.ts` holds `Tx`, `Q` and `lockRow`. `platform/streams/` holds SSE, stream opening, stream scopes and the registry. `platform/storage/` holds the blob storage backend. `service-core` is gone; `lib/service.ts` re-exports its symbols for the files that still use the barrel. **Open decisions:** `lib/service-queue.ts` (events, agent cursors, work sessions) could not be split cleanly, because the session functions read events and cursors and the queue functions read work sessions, so it stays whole in `lib/` until we decide where the agent queue lives (a module of its own is the likeliest answer); `lib/images.ts` writes `users.avatar_key` and `workspaces.image_key`, which `auth` owns, so it stays in `lib/` with its controller until the avatar rows are decided; `service-checklist`, `links.ts`, `metrics.ts` and the dashboard are not placed yet.
- **Leftovers placed (done):** `links.ts` is split between its owners (`common/labels` for the pure label cleaning, `modules/issues/links` for issue labels and cycle numbers, `modules/map/links` for the nodes an ADR applies to). `modules/dashboard/` holds the read models that look across areas: `metrics` (the widgets), the team setup checklist (`checklist`, `setup-checklist`), `DashboardService` (the widget lookup moved out of the controller into it), `DashboardModule` (the api role only) and the dashboard controller. These read other modules' tables on purpose; once the boundary rule is an error they are the first to move to calling services. `LegacyApiModule` now holds only MCP, v1, the people's stream and images.
- **Next for daemon:** the `device_*` tables in their own schema file, and Zod DTOs on the routes that take a body (keeping today's error messages).
- **Not started:** DTOs on existing routes, the global exception filter, per-module schema files, the shared browser package.
