# Cross-workspace isolation audit (WH-50)

Wheelhouse can host several unrelated workspaces on one server and one database. The rule: **workspace B can never read or change anything workspace A owns.** This file records how each entry point enforces it, what the audit found, and how it stays true.

Audited 2026-10-14 against commit `dfb9438` plus the fixes listed below. Method: read every exported function in `service.ts`, `sync.ts`, `metrics.ts`, `briefing.ts`, `ask.ts`, `invites.ts`, `workspaces-admin.ts` and `access.ts`, every tool in `tools.ts`, every server action in `actions.ts`, every route, and every page that queries the database, noting for each query how it is scoped to the caller's workspace.

## How scoping works

Everything hangs off two resolvers in `service.ts`:

- `requireTeam(actor, ref)` filters `teams.workspace_id = actor.workspaceId`. Every team-level function resolves its team through it, then filters every other table by `team_id`.
- `resolveIssue(actor, ref)` joins `teams` and filters `teams.workspace_id = actor.workspaceId`, for issue uuids and for `KEY-n` refs. `resolveNode` / flows / terms / decisions / edges / drafts / sessions are always looked up inside the already-resolved team.

Team keys are per workspace (two workspaces can both have `SH`), so a bare key never identifies a team on its own; it is always combined with the caller's workspace.

## Entry points

| Entry point | How it is scoped | Verified by |
|---|---|---|
| All 42 MCP / REST tools (`tools.ts`) | each calls a service function that resolves through `requireTeam` / `resolveIssue` | `isolation.test.ts`: every tool attacked with workspace A's ids as B's human and B's agent |
| `service.ts` (teams, issues, comments, map, flows, decisions, glossary, events, queue) | `requireTeam` / `resolveIssue` first; later queries filter by the resolved team id | same, plus fingerprint of workspace A's data unchanged |
| `sync.ts` (sessions, landing, drafts) | `requireTeam` first; drafts and sessions filtered by the workspace's team id; session ids are checked against the calling key | attacks on `session_*`, `land_changes`, `list_drafts`, A's session id used by B |
| `metrics.ts` (dashboard) | everything derived from the caller's workspace's team ids / `events.workspace_id` | dashboard numbers for B contain nothing of A |
| `briefing.ts`, `ask.ts` | go through `getGraph` / `resolveIssue` | refusal tests; Ask refuses before it would call the model |
| `members.ts` (update/remove member, revoke key) | every statement filtered by the caller's workspace id | B's owner cannot touch A's members or keys |
| Server actions (`actions.ts`) | listed one by one in `ACTION_AUDIT` in the test | guard test fails on an unlisted action |
| Pages that query directly (`agents`, `workspace`, `p/[key]`) | filtered by the caller's workspace id | listed in `DB_FILE_AUDIT` |
| `access.ts` (sessions, API keys) | a key belongs to one workspace; a suspended workspace is refused | `workspaces-admin.test.ts` |
| `invites.ts` | issuer's workspace comes from the session; acceptance uses the invite's own workspace, email and role | `invites.test.ts` |
| `workspaces-admin.ts` and the admin pages | instance admins only (`ADMIN_EMAILS`); metadata only | `workspaces-admin.test.ts` |
| `/mcp`, `/api/v1/<tool>` | authenticate, then call the tools above | end-to-end checks in the production image |
| `/api/health` | `select 1`, no data | n/a |
| Custom pictures (`images.ts`, `/api/app/images`, avatar and workspace image routes) | writes touch the caller's own user row or the session's workspace (owners and admins only); reads are limited to the caller's own workspace's image and pictures of its members | `images.test.ts`: another workspace, a stranger, a member without the right, the wrong kind of file |
| Agent daemon (`daemon.ts`, `/api/daemon/*`, `/api/app/devices`, runs on an issue) | a device belongs to one person in one workspace; people reach only their own devices (owner and workspace id) and runs through `resolveIssue`; a device's token names one device, which reaches only its own jobs and messages | `daemon.test.ts`: another person's and another workspace's device, another device's job, a stranger reading a run |
| Chat with the codebase (`chat_threads`, `chat_messages`, `/api/app/chats`, `/api/daemon/chat/*`) | a thread belongs to its owner alone, selected by thread id AND owner id AND workspace id; it runs only on a device the owner owns; the device's token reaches only messages of threads on that device | `chat.test.ts`: a teammate and another workspace cannot read, send, cancel or delete; another device cannot report |
| Agents (`workspace_agents`, `team_agents`, `/api/app/agents`, `/api/app/teams/:key/agents`, `/api/v1/team-agents`) | every statement starts from the workspace id of the person or key; rosters are read through a team the person can open (`TeamAccessService.require`), so a key sees only its scoped teams and a team agent is invisible outside its team; workspace-wide changes and pins are for workspace admins | `agents.test.ts`: another workspace and another team cannot list, edit, delete or add by slug, the plugin route is scoped to the key's teams |

## Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `assigneeId` on an issue was not checked, so an issue could be assigned to a user id from another workspace | low (needs a foreign user id; no data came back) | **fixed**: assignees must be members of the caller's workspace |
| 2 | Creating a join invite for an email that already had an account returned "an account with that email already exists" to any workspace owner, so owners could probe which addresses are registered on the server (in any workspace) | medium (account enumeration across workspaces) | **fixed**: owners get the same answer either way; the link just never works. Only instance admins are told |
| 3 | `cursorFor` passed a JavaScript `Date` inside a raw SQL fragment, which the in-memory test database accepts and the real Postgres driver rejects, so **`get_changes` failed for every API key that had never acknowledged anything**. Not a leak, but a production bug the isolation suite found only because it was run on real Postgres | high (core feature broken on Postgres) | **fixed** (`lte()` instead of raw SQL); the database suites now also run on real Postgres in CI |
| 4 | Session ids are one global namespace (`work_sessions.id`). A workspace could register a guessable id and make another workspace's agent get "belongs to another API key" on it, and the message confirms an id exists elsewhere | low (Claude Code uses random UUIDs; no read or write across workspaces, verified) | accepted; follow-up issue to namespace ids per API key |
| 5 | Within one workspace: any member (not only owners) can create API keys and call `delete_project` / `delete_issue` | not cross-workspace | out of scope; `delete_project` is covered by WH-58 |
| 6 | No database-level unique index on `(workspace_id, team key)`; uniqueness is checked in code, so two simultaneous creates could produce two teams with one key in the same workspace | low (within one workspace) | follow-up issue |

No path was found by which one workspace can read or write another workspace's data.

## Keeping it true

`tests/isolation.test.ts` fails the build when:

- a **tool** is added without an attack entry (compile-time `satisfies Record<ToolName, …>` plus a runtime comparison),
- an **API route** (any `@Get`/`@Post`/… in `apps/api`) is added without an entry in `API_ROUTE_AUDIT`,
- a **file that calls `getDb()`** (in `apps/api`) is added without an entry in `DB_FILE_AUDIT`. A controller or guard must never appear there: only the service layer touches the database.

Each attack must be refused with a clean error (not a validation error, not a crash), return none of workspace A's data, and leave a hash of everything workspace A owns unchanged. The suite was checked by deliberately removing the workspace filter from `requireTeam`, from `resolveIssue` and from `revokeApiKey`: it failed each time.

CI runs the database suites (queue, invites, admin, isolation) against a real Postgres as well as the in-memory one.

Not covered by tests: page rendering in the React app (it only calls the audited API), and anything an operator runs by hand. Postgres row-level security would add a second wall and is a possible follow-up.
