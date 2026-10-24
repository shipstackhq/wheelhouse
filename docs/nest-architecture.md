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

Zod schemas, applied by a pipe (`common/pipes/zod-validation.pipe.ts`). One schema gives both the TypeScript type and the runtime check. A failure is a `ServiceError("invalid")` with `details.fields`, the shape the app already sends. `zod` is a dependency of `apps/api`, so no new tooling is introduced. The app reads bodies as raw text, so a route takes its body as `@JsonBody(new ZodValidationPipe(schema)) dto` (`common/decorators/json-body.decorator.ts` parses it with the same 400 as before, then the pipe shapes it). The teams module's routes use it; the DTOs live in `modules/<area>/dto/`. Two Zod 4 details: a plain `z.unknown()` field rejects a missing key, so pass-through fields use `anything` (`z.unknown().optional()`) from `common/pipes/lenient.ts`; and the lenient helpers (`text`, `textOrNull`, ...) shape a field the way the controllers always did, so the service keeps judging the values and today's error messages stay.

## Errors and identity

- `common/filters/service-error.filter.ts` renders a `ServiceError` through `src/lib/api-errors`'s `appFailure`, the same mapping every controller uses. It is registered globally (`APP_FILTER` in `common/request-pipeline.module.ts`), so a controller without a filter of its own (health, stream, webhook, github) answers a `ServiceError` in the app's envelope instead of a 500; a controller's own filter (the app's, v1's, MCP's, the daemon's) still comes first. The envelopes differ by API surface on purpose, so those filters stay with their surface.
- `@CurrentActor()` returns the actor the guards set: `req.actor` for API keys and sessions on `/mcp` and `/api/v1`, `req.human.actor` for signed-in people on `/api/app`.

## Service roles

One build, one or several processes. `SERVICE_ROLE` is `api`, `daemon` or `all` (the default); anything else stops the server at boot. The role decides which modules are loaded, never what a module does (`app.imports.ts`, `platform/config/service-role.ts`):

| Role | Serves |
|---|---|
| `api` | people and agents: the legacy group (`/api/app`, `/api/v1`, `/mcp`, GitHub, streams) and the person's side of the daemon module (`/api/app/devices`, runs on an issue) |
| `daemon` | paired machines: `/api/daemon` and the sweep that expires offers and marks quiet devices' jobs unreachable |
| `all` | both, in one process |

`/api/health` and the platform modules are in every role. The sweep runs only where the daemon role runs, so it ticks in one process. Splitting the daemon traffic into its own process is then a deployment choice (`SERVICE_ROLE=daemon`) and not a rewrite. Both processes use the same database; each module still reads and writes only its own tables.

## Module internals (decided 2026-10-24)

The modules exist and their boundaries hold; this is the shape of the code inside them. Principle: less is more. Use what Nest gives (providers, injection, modules, lifecycle) and add as little of our own as possible.

Per module, flat (no sub-folders beyond `dto/`):

| File | Holds | Rule |
|---|---|---|
| `<area>.repository.ts` | every query on the module's own tables | the only file in the module that touches Drizzle; reads `this.db.q` (see transactions) |
| `<area>.service.ts` | the use cases: access checks, rules, events, the transaction | a real `@Injectable()` class; the logic lives here, not in plain functions |
| `<area>.controller.ts` | HTTP only | parses with a DTO, calls the service, maps with the presenter |
| `<area>.presenter.ts` | row to API shape (what the `*-app.ts` files did) | pure functions |
| `dto/` | Zod schemas | the only input validation for HTTP |
| `<area>.rules.ts` | pure rules worth testing alone (health, loop checks, positions) | only when there is such a rule; no database |
| `index.ts` | the service class and the types callers need | no plain functions once the module is converted |

A module that is large splits by service, not by layer: `ProjectsService`, `CyclesService` and `IssuesService` can sit side by side, each with its repository, in one module or in their own.

**Cross-module calls** go through the other module's service, injected: the consuming module lists the provider's module in its `imports` (`imports: [TeamsModule]`, importing `../teams/teams.module`, the one file besides `index.ts` that another module may import; `index.ts` never exports the module class, so importing a helper never loads controllers) (for teams that is `TeamAccessService`: `require`, `roleOn`, `visibleTeamIds`, `roleMap`, `workspaceRoleOf`, `audit`; `TeamsService` is the controllers' door for the teams themselves, and the module splits the rest by concern into lifecycle, members and statuses services, each over the one `TeamsRepository`) (`constructor(@Inject(TeamsService) private teams: TeamsService)`; `tsx` emits no decorator metadata, so every injection names its token). A module that only needs to tell others that something happened emits an event instead of calling them; that is how the `map` and `github` cycle goes away.

**Access checks stay in the services** (`this.teams.require(actor, key, "edit")`), not in a guard: the same services serve people over HTTP and agents through the tools, and the isolation audit reads them.

**Transactions:** `platform/database` provides `Database`, with `q` (the current transaction, or the client outside one), `transaction(fn)` (joins an outer transaction if there is one; `fn` takes no argument, so no `tx` is passed through signatures) and `within(q, fn)` (runs `fn` with a given handle as the current one; only the shims use it, see below). The transaction lives in `AsyncLocalStorage`. The client is the one `src/db/index.ts` wraps with `publishAfterCommit`, so an event emitted inside a transaction publishes after the commit. `EventsService.emit(actor, teamId, e)` reads `q` itself, so an event still commits with the change. The old `emit(q, ...)` function stays for unconverted callers.

**Tests** boot the real providers once per file with `NestFactory.createApplicationContext` (`test/app.ts`: the whole `AppModule` in the `api` role, over the in-memory PGlite the test chose) and take services with `(await testApp()).get(...)`. A test file starts it with `await testApp();` at the top level, after its imports: not in `before`, because node:test starts a root-level `before` the moment it is registered, so a second `before` that uses a shim would run while the first is still booting. No new test library.

**While converting (temporary):** code not converted yet still calls plain functions. A converted module keeps those names as one-line shims in `<area>.legacy.ts` that forward to the live service instance (the module class captures its services in `onModuleInit` and hands them to `bindXLegacy`), exported from `index.ts` until the last caller moves; a shim that takes a `q` runs through `Database.within(q, ...)`, so a caller's own transaction stays the one the service writes on, and a shim called before the application booted throws a clear error; the `lib/service.ts` barrel forwards the same way for the tools. Shims and the barrel are deleted when the MCP redesign moves the tools onto the services.

Order: `teams` (everything depends on it; it sets the pattern), then `docs`, `github`, `map`, `issues` (split into issues, projects and cycles services), `auth`, `daemon`, `dashboard` (reads through the other services instead of their tables).

## Migration

Strangler, one area at a time. `daemon` is the pilot. For each area: create the module, move its service and DTOs, switch its controllers to the service, leave the `src/lib` functions in place for the other callers until they are moved too. Routes, responses and the contract suite (`pnpm test:contract`) must not change in any step.

## Boundary enforcement

`eslint.config.mjs` restricts, for files under `apps/api/src/modules/**`, imports of another module's internal files (anything but its `index.ts`). The rule is `no-restricted-imports` at `error`. Test files are exempt, because they build their fixtures from other modules' internals. A module's `index.ts` exports its service, the helpers and types other modules need, and not its Nest module class: a plain helper's importer would otherwise load the module's controllers, and the controllers import the request plumbing that is itself importing those helpers (a load-order cycle). `app.imports.ts` imports each module class from its `<area>.module.ts` directly.

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
- **Boundary rule is an error (done):** the pure helpers the modules shared moved to `common/` (`crypto`, `uuid`, `roles`, `labels`). Each module's `index.ts` now lists what the others may use: `teams` (`requireTeam`, `roleOnTeam`, `visibleTeamIds`, `teamRoleMap`, `workspaceRoleOf`, `audit`), `auth` (`Human`), `map` (`resolveNode`, `upsertNode`, `landedHashesFor`, `normPath`, `land`), `docs` (`DocRow`), `github` (`findOrCreateRepository`, `GithubApiError`, `GithubApi`, `github`) and `dashboard` (`ChecklistState`, `checklistBriefingLine`). The rule only sees relative imports between modules. Known couplings it does not fix: `map` and `github` call each other (a repository has a system node on the map), `workspaceRoleOf` in `teams` reads the `memberships` table that `auth` owns, `dashboard` reads other modules' tables, and `lib/service.ts` still re-exports module internals for the files that use the barrel.
- **Barrel retired except for the tools (done):** nothing but `lib/tools.ts` imports `lib/service.ts` any more. Production code takes `ServiceError`, `emit`, `Tx`/`Q` and the rest from where they live, and reaches other modules through their `index.ts` (which grew by the helpers that callers needed: `resolveIssue`, `getBoard`, `getGraph`, `listRepositories`, `checklistForTeam`, `listDocsIndex` and a few more). Tests import the defining files directly. The barrel dies with the MCP redesign, when the tools call the module services.
- **DTOs (done, in two kinds):** every route that takes a JSON body declares it with `@JsonBody`, and none parses `jsonBody(req)` by hand any more. Routes whose body is a few known fields have a Zod DTO in the module's `dto/` folder (teams, auth, the daemon's device approve and deny, the map's draft resolve, an issue's comment, images), using the lenient helpers so the services keep judging the values and today's messages stay. Routes whose body is passed on whole to a function that already shapes and checks it (`issueInput`, `nodeInput`, `layoutInput`, the `*As(actor, key, body)` functions, the daemon's machine API) take `@JsonBody() body: JsonObject`: giving those a Zod schema means rewriting each shaper with the same error messages and the same order of checks, which is a separate change per shaper and not worth the risk until one of them needs to change. The three routes that must keep the raw bytes stay as they are on purpose: the webhook (the signature is over the raw body), MCP (JSON-RPC) and `/api/v1` (an unparseable body counts as no arguments).
- **Request pipeline (done):** the guards, filters and HTTP helpers moved to `common/guards`, `common/filters`, `common/decorators` and `common/http` (the old `web/endpoints`, `web/csrf`, `auth/*.guard`, `http/*`). `@AppEndpoints()` now includes the session guard, so every `/api/app` route is closed by default and the six open sign-in and invite routes say `@Public()` (the isolation audit checks both directions). `RequestPipelineModule` (imported by `AppModule`) declares the raw-text body middleware and the global `ServiceError` filter, so `main.ts` no longer wires them. Left as they were on purpose: rate limiting (limits are keyed per email, user, key or device and carry the services' own messages, so they stay in the services as `common/rate-limit`), and the device guard, which belongs to the daemon module.
- **Schema files (done):** `apps/api/src/db/schema.ts` is now a barrel over one file per owning area in `db/tables/` (`auth`, `teams`, `issues`, `map`, `docs`, `github`, `daemon`, `events`), following the table-ownership map above; `common.ts` holds the `table` wrapper (with the enum CHECKs) and the timestamp columns, and `team-scope.ts` the workspace-agreeing foreign key. The files stay under `db/` rather than inside the modules because foreign keys cross areas (the tables are one database-level contract) and a module may not import another's internals. `drizzle-kit generate` reports no schema changes, so the migrations and snapshots are untouched. The config and every `import * as schema` are unchanged.
- **Module internals, phase 1 (done):** `platform/database` provides `Database` (`q`, `transaction`, `within`), `EventsService.emit(actor, teamId, e)` reads it, and `test/app.ts` boots the real providers for tests (`await testApp();` at the top of every test file that touches the database, and in the contract seed). `modules/teams/` is converted to the shape above: `TeamsRepository` (the only Drizzle file), `TeamAccessService`, `TeamsService`, `TeamLifecycleService`, `TeamMembersService`, `StatusesService`, `teams.presenter.ts`, and the three controllers calling the services. The old plain functions are one-line shims in `teams.legacy.ts` (`index.ts`, `lib/service.ts` and the tests use them); `teams.ts`, `team-access.ts`, `team-lifecycle.ts`, `team-members.ts` and `statuses.ts` are gone. Routes, responses, messages and events are unchanged. The isolation audit now also counts files that read `this.db.q`, so the repository has an entry. Deviations from the spec, on purpose: the module's one injectable for other modules is `TeamAccessService`, not `TeamsService.require`; the tests start the app with a top-level `await`, not `before`; the status queries that touch `issues` (counts, moving issues) stay in the teams repository as they were in `statuses.ts`.
- **Module internals, phase 2 (done):** `modules/docs/` is converted to the shape above: `DocsRepository` (the only Drizzle file, covering docs, doc nodes and the reads the page needs), `DocsService` (the logic of the former `docs.ts` and `docs-app.ts`; the `...As` methods take the raw body and the controller maps with `docs.presenter.ts`), `docs.rules.ts` for the pure rules (limits, slugs, path-token extraction), and `docs.legacy.ts` with the shims for the MCP tools, the map module and the tests. `docs.ts` and `docs-app.ts` are gone. `DocsModule` imports `EventsModule` and `TeamsModule`. Routes, responses, messages and events are unchanged.
- **Not started:** Zod schemas for the whole-body routes (see DTOs), the shared browser package.
