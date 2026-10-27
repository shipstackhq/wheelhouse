# MCP redesign

Status: **agreed, to build**, 2026-10-26, on `wh/mcp-redesign`. A clean break from today's surface: no aliases, no compatibility layer.

## Why

- Every tool takes `project`, which means a team. Since Projects arrived (Linear's meaning) that word is wrong.
- Cycles, projects, milestones, assignees and workspaces are missing.
- 52 listed tools, most of them one REST call each. Agents chain three calls where one would do.
- The tools still reach the services through the `lib/service.ts` barrel and the `*.legacy.ts` shims (docs/nest-architecture.md).

## Principles

1. Tools are designed from what an agent does in a task, not from the endpoint list.
2. Few, rich tools. One call returns what the next step needs. Batches over loops.
3. Safety by scope, not by omission: every tool declares the scope it needs; a key gets only the tools its scopes allow.
4. Output is for a model: refs (`WH-42`, `docs/runbooks/deploy`) not uuids, trimmed fields, errors that say what to call instead.
5. Destructive and admin actions stay in the UI.
6. Stateless HTTP stays. A tool's behaviour reloads with the server; the tool list is read when a client connects (`listChanged: false`).

## Scope model

A key belongs to one workspace and reaches the teams in `api_key_teams` (unchanged). `team` is the only scoping argument a tool takes,
optional where the key reaches a single team.

| Scope | Allows | Default for a new key |
|---|---|---|
| `read` | every read tool | on |
| `board:write` | create/update issues, comment | on |
| `map:write` | `update_map`, `mark_fresh`, `record_decision`, `define_term` | on |
| `docs:write` | `write_doc` (today's capability) | off |
| `planning:write` | `plan` | off |

`api_keys.capabilities` grows from `["docs:write"]` to these five. Existing keys are migrated to the defaults plus `docs:write` where set.
Chat runs get a key minted per message: `read` only, the thread's team, expiring when the answer ends (or after the chat timeout,
10 minutes, at the latest). It is never stored on the device. Daemon runs get `read`, `map:write` and `board:write` limited to their own issue.

## Tools (19)

| Tool | Scope | What it does | Replaces |
|---|---|---|---|
| **Orient** | | | |
| `get_briefing(team?)` | read | Team context: teams, repositories, current cycle, active projects, recent activity, stale counts, setup gaps | `get_briefing`, `list_projects`, `list_repositories`, `get_activity` |
| `get_changes(team, ack?)` | read | Your queue since your cursor; `ack` acknowledges up to a seq first | `get_changes`, `ack_changes` |
| **Issues** | | | |
| `list_issues(team, filter?)` | read | Filter by status, assignee (`"me"`), cycle, project, label, text; grouped by status | `get_board` |
| `get_issue(ref)` | read | Issue, comments, parent and sub-issues, cycle, project, milestone, linked nodes, docs and decisions, files to read first | `get_issue`, `get_issue_context` |
| `create_issue` | board:write | Fields as today plus `assignee`, `cycle`, `project`, `milestone`, `link_nodes` | same |
| `update_issue(ref, …)` | board:write | Any field, including `status`, `assignee` (`"me"` claims), `cycle` (`"current"`, `"next"`, number, null), `project`, `milestone`, `link_nodes`/`unlink_nodes`; `expected_version` | `update_issue`, `move_issue`, `claim_issue`, `link_issue_node` |
| `comment(ref, body)` | board:write | Unchanged | same |
| **Planning** | | | |
| `get_project(ref)` | read | Project with milestones, teams, health, issues by status | new |
| `get_cycle(team, which?)` | read | `current` (default), `next` or a number: dates, scope, progress, what landed | new |
| `plan(changes[])` | planning:write | Batch: create/edit cycles, projects, milestones | new |
| **Map** | | | |
| `get_map(team, layer?, node?, flow?)` | read | The graph, one node in full, one flow, or the data layer | `get_graph`, `get_node`, `get_flows`, `get_schema` |
| `update_map(team, changes[])` | map:write | Batch of upsert/remove node, edge, table, flow | `upsert_node`, `delete_node`, `upsert_edge`, `unlink_nodes`, `upsert_table`, `upsert_flow`, `delete_flow` |
| `get_stale(team)` | read | Stale nodes and docs, and pending drafts | `get_stale_nodes`, `get_stale_docs`, `list_drafts`, `list_doc_drafts` |
| `mark_fresh(team, refs[])` | map:write | Nodes or docs confirmed still true | `mark_fresh`, `mark_doc_fresh` |
| **Knowledge** | | | |
| `list_knowledge(team, kind)` | read | The team's docs (as a tree), decisions or glossary terms | `list_docs`, `list_decisions`, `list_terms` |
| `get_doc(ref)` | read | Content wrapped as untrusted, as today | same |
| `write_doc(…)` | docs:write | Create or update; template ids listed in the description; links to nodes; returns suggested anchors | `upsert_doc`, `link_doc_node`, `suggest_doc_anchors`, `list_doc_templates` |
| `record_decision(…)` | map:write | Create or update an ADR | `upsert_decision` |
| `define_term(…)` | map:write | Create or update a glossary term | `upsert_term` |

**Not MCP tools, REST `/api/v1` only** (the CLI and hooks): `session_sync`, `session_status`, `session_end`, `land_changes`,
`report_changes`, `resume_session`. They take `team` instead of `project`.

**Gone from the agent surface** (UI only): `create_project` (a team), `delete_project`, `delete_issue`, `delete_doc`, `delete_term`.

**Left out on purpose:** search. Wheelhouse has no search yet; a `search` tool comes when the product has one, and `search_docs`
goes with this break. Carrying unfinished issues into the next cycle is the server's rollover (`CyclesService.rolloverCycles`), not an
agent loop. Initiatives stay read-only, through `get_project`.

## Server shape

- `lib/tools.ts` becomes a registry where each tool calls the module services through Nest (no barrel). `lib/service.ts` and the
  `*.legacy.ts` shims used only by the tools are deleted.
- Each tool declares `scope`; `tools/list` filters by the key's scopes, `tools/call` refuses a missing scope with `forbidden` naming it.
- `mcp.ts` keeps its transport; `INSTRUCTIONS` and `prompts.ts` are rewritten for the new names.
- One contract test per tool: the scope check and the shape of its answer.

## Clients (`wheelhouse-cli`)

- `wheelhouse.json`: `project` becomes `team`. `wheelhouse init --team KEY`.
- CLI: `get_ticket_context` (already stale) becomes `get_issue`; `list_projects` becomes `get_briefing`; `ack_changes` folds into
  `get_changes`; session calls pass `team`.
- Plugin: the skill, the commands and `INSTRUCTIONS` use the new names. The `pre-mcp` hook still adds the session id.
- Plugin and CLI versions bump together; old clients get a clear error from the server, not silent breakage.

## Build order

1. Scopes: migration for `api_keys.capabilities`, the keys page toggles, the filter in `mcp.ts`.
2. Read tools (orient, issues, planning, map, knowledge).
3. Write tools, then `plan`.
4. REST-only session tools renamed to `team`.
5. Delete the barrel and the tool-only shims.
6. `wheelhouse-cli`: CLI, plugin, skill, commands; release both.

