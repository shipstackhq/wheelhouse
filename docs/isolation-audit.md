# Cross-team isolation audit (WH-50)

Wheelhouse can host several unrelated teams on one server and one database. The rule: **team B can never read or change anything team A owns.** This file records how each entry point enforces it, what the audit found, and how it stays true.

Audited 2026-10-14 against commit `dfb9438` plus the fixes listed below. Method: read every exported function in `service.ts`, `sync.ts`, `metrics.ts`, `briefing.ts`, `ask.ts`, `invites.ts`, `teams-admin.ts` and `access.ts`, every tool in `tools.ts`, every server action in `actions.ts`, every route, and every page that queries the database, noting for each query how it is scoped to the caller's team.

## How scoping works

Everything hangs off two resolvers in `service.ts`:

- `getProject(actor, ref)` filters `projects.team_id = actor.teamId`. Every project-level function resolves its project through it, then filters every other table by `project_id`.
- `resolveTicket(actor, ref)` joins `projects` and filters `projects.team_id = actor.teamId`, for ticket uuids and for `KEY-n` refs. `resolveNode` / flows / terms / decisions / edges / drafts / sessions are always looked up inside the already-resolved project.

Project keys are per team (two teams can both have `SH`), so a bare key never identifies a project on its own; it is always combined with the caller's team.

## Entry points

| Entry point | How it is scoped | Verified by |
|---|---|---|
| All 42 MCP / REST tools (`tools.ts`) | each calls a service function that resolves through `getProject` / `resolveTicket` | `isolation.test.ts`: every tool attacked with team A's ids as B's human and B's agent |
| `service.ts` (projects, tickets, comments, map, flows, decisions, glossary, events, queue) | `getProject` / `resolveTicket` first; later queries filter by the resolved project id | same, plus fingerprint of team A's data unchanged |
| `sync.ts` (sessions, landing, drafts) | `getProject` first; drafts and sessions filtered by the team's project id; session ids are checked against the calling key | attacks on `session_*`, `land_changes`, `list_drafts`, A's session id used by B |
| `metrics.ts` (dashboard) | everything derived from the caller's team's project ids / `events.team_id` | dashboard numbers for B contain nothing of A |
| `briefing.ts`, `ask.ts` | go through `getGraph` / `resolveTicket` | refusal tests; Ask refuses before it would call the model |
| `members.ts` (update/remove member, revoke key) | every statement filtered by the caller's team id | B's owner cannot touch A's members or keys |
| Server actions (`actions.ts`) | listed one by one in `ACTION_AUDIT` in the test | guard test fails on an unlisted action |
| Pages that query directly (`agents`, `team`, `p/[key]`) | filtered by the caller's team id | listed in `DB_FILE_AUDIT` |
| `access.ts` (sessions, API keys) | a key belongs to one team; a suspended team is refused | `teams-admin.test.ts` |
| `invites.ts` | issuer's team comes from the session; acceptance uses the invite's own team, email and role | `invites.test.ts` |
| `teams-admin.ts` and the admin pages | instance admins only (`ADMIN_EMAILS`); metadata only | `teams-admin.test.ts` |
| `/mcp`, `/api/v1/<tool>` | authenticate, then call the tools above | end-to-end checks in the production image |
| `/api/health` | `select 1`, no data | n/a |

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `assigneeId` on a ticket was not checked, so a ticket could be assigned to a user id from another team | low (needs a foreign user id; no data came back) | **fixed**: assignees must be members of the caller's team |
| 2 | Creating a join invite for an email that already had an account returned "an account with that email already exists" to any team owner, so owners could probe which addresses are registered on the server (in any team) | medium (account enumeration across teams) | **fixed**: owners get the same answer either way; the link just never works. Only instance admins are told |
| 3 | `cursorFor` passed a JavaScript `Date` inside a raw SQL fragment, which the in-memory test database accepts and the real Postgres driver rejects, so **`get_changes` failed for every API key that had never acknowledged anything**. Not a leak, but a production bug the isolation suite found only because it was run on real Postgres | high (core feature broken on Postgres) | **fixed** (`lte()` instead of raw SQL); the database suites now also run on real Postgres in CI |
| 4 | Session ids are one global namespace (`work_sessions.id`). A team could register a guessable id and make another team's agent get "belongs to another API key" on it, and the message confirms an id exists elsewhere | low (Claude Code uses random UUIDs; no read or write across teams, verified) | accepted; follow-up ticket to namespace ids per API key |
| 5 | Within one team: any member (not only owners) can create API keys and call `delete_project` / `delete_ticket` | not cross-team | out of scope; `delete_project` is covered by WH-58 |
| 6 | No database-level unique index on `(team_id, project key)`; uniqueness is checked in code, so two simultaneous creates could produce two projects with one key in the same team | low (within one team) | follow-up ticket |

No path was found by which one team can read or write another team's data.

## Keeping it true

`src/lib/isolation.test.ts` fails the build when:

- a **tool** is added without an attack entry (compile-time `satisfies Record<ToolName, …>` plus a runtime comparison),
- a **server action** is added without an entry in `ACTION_AUDIT`,
- a **file that calls `getDb()`** is added without an entry in `DB_FILE_AUDIT`.

Each attack must be refused with a clean error (not a validation error, not a crash), return none of team A's data, and leave a hash of everything team A owns unchanged. The suite was checked by deliberately removing the team filter from `getProject`, from `resolveTicket` and from `revokeApiKey`: it failed each time.

CI runs the database suites (queue, invites, admin, isolation) against a real Postgres as well as the in-memory one.

Not covered by tests: server actions' form handling and page rendering (they call the audited functions), and a future SSE stream (WH-1) which must authorize per project. Postgres row-level security would add a second wall and is a possible follow-up.
