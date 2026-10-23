# NestJS architecture (ADR)

Status: accepted, 2026-10-23. First step only: the layout, the platform layer and the boundary rule. Moving server logic and schema into `apps/api`, and the shared browser code into a small package, come later.

## Decision

`apps/api` becomes a native NestJS application: one module per domain area, injectable services, DTOs validated at the edge, one exception filter, guards and decorators. Each module owns its tables and reaches the others only through their exported services, so that any module can later become its own service (a Go one included) without its callers changing shape.

Until a module is migrated, its controllers keep calling `@wheelhouse/core` directly (strangler pattern). Nothing is rewritten in bulk.

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

`platform/` holds infrastructure every module needs; it wraps what core already does (`getDb()`, the environment, `emit`) so core's functions keep working unchanged. `common/` holds Nest plumbing that knows nothing about a domain.

## Table ownership

Every table in `packages/core/src/db/schema.ts` has exactly one owner. The first cut was checked against the schema's own comments.

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

**TO DECIDE** (four tables, each written by more than one module):

- `events`: the append-only event log every write goes through (`emit`). Owner is either `platform/events` or a future activity module; this needs a decision before `EventsService` gains readers.
- `workspace_events`: the same log for workspace-level changes (projects, initiatives). Goes with `events`.
- `agent_cursors`: an API key's read position in a team's event log. Could be `auth` (it is keyed by the key) or the event log's consumer.
- `issue_nodes`: links an issue to a map node. Both `issues` and `map` write it.

## Rules

1. A module reads and writes only its own tables. For anything else it calls another module's exported service.
2. A module's `index.ts` is its only public surface. No module imports another module's internal files.
3. Cross-module transactions: inside one process, a module may pass a transaction handle to another module's exported service, so one commit covers both. If a module is later split out, that call becomes an API or event call, and the transaction boundary is redesigned at that point, not before.
4. Notifications between modules go through the in-process events module over the existing event log (`EventsService.emit`, which wraps core's `emit`). A module never reads another module's tables to learn that something changed.
5. Controllers parse input through a Zod pipe and call services; they hold no business logic and call no database directly.

## Validation

Zod schemas, applied by a pipe (`common/pipes/zod-validation.pipe.ts`). One schema gives both the TypeScript type and the runtime check. A failure is a `ServiceError("invalid")` with `details.fields`, the shape the app already sends. `zod` is already a dependency of `packages/core` (`^4.6.7`); `apps/api` now declares the same range, so no new tooling is introduced. No existing route uses the pipe yet.

## Errors and identity

- `common/filters/service-error.filter.ts` renders a `ServiceError` through core's `appFailure`, the same mapping every controller uses today. It is not yet registered globally: a controller without its own filter (health, stream, webhook, github) would otherwise change its answer for a `ServiceError`. Registration waits until those controllers have filters.
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

Strangler, one area at a time. `daemon` is the pilot. For each area: create the module, move its service and DTOs, switch its controllers to the service, leave core functions in place for the other callers until they are moved too. Routes, responses and the contract suite (`pnpm test:contract`) must not change in any step.

## Boundary enforcement

`eslint.config.mjs` restricts, for files under `apps/api/src/modules/**`, imports of another module's internal files (anything but its `index.ts`). The rule is `no-restricted-imports` at `warn` while the migration runs. It becomes `error` when the last area is migrated.

## Status

- **Daemon pilot, step 1 (done):** `modules/daemon/` has the module (`DaemonModule.register(role)`), `DaemonService` (the module's one door; each method hands over to `@wheelhouse/core/lib/daemon` for now), the device guard and exception filter, both controllers and the sweep. Every other controller sits in `LegacyApiModule` until its area gets a module. Routes, responses and the contract suite are unchanged.
- **Next for daemon:** move the logic from `packages/core/src/lib/daemon.ts` into the module (service, DTOs), split the people-side and machine-side services if they diverge, and give `device_*` tables their own schema file.
- **Not started:** DTOs on existing routes, the global exception filter, per-module schema files, the shared browser package.
