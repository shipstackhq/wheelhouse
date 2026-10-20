# Agent keys and dispatch routing by team (WH-120)

## Access

Teams are the unit of access (ADR-23). A person opens a team through `team_members`; an agent key opens a team through `api_key_teams`; a system actor opens the one team it was made for. There is one path for all three: `requireTeam`, `resolveTicket`, `listTeams` and the stream scopes ask `roleOnTeam`, `visibleTeamIds` and `teamRoleMap` in `lib/team-access.ts`. A team an actor cannot open is `not_found`, never `forbidden`, so existence does not leak.

- A key's role on a scoped team is `editor`. Settings, members and deleting a team need a person who is an admin of it.
- A key with no rows reaches nothing. It is not "all teams".
- Keys are scoped when created (default: every team the creator edits) and can be changed from the Agents page. The person needs to edit a team to give it to a key; teams they do not edit are left as they are.
- Nothing is cached: scope is read on every call.

## Routing (design; the dispatcher is WH-32)

The rule: **a worker only ever gets work from teams it belongs to, and a team's ready tickets are only offered to workers that belong to it.**

Data model, to be created with the dispatcher:

```
workers      (id, workspace_id, machine_id, name, kind, last_seen_at, …)      -- one per agent process / runtime
worker_teams (worker_id, team_id, workspace_id)  PK (worker_id, team_id)      -- composite FKs: both ends in the same workspace
```

- A worker authenticates with an agent key. It may belong only to teams that key is scoped to; the dispatcher checks `worker_teams ⊆ api_key_teams` each time it assigns, so narrowing a key takes effect at once without touching the worker.
- Offering work: for a team T, the candidates are workers with a `worker_teams` row for T whose key is still scoped to T. A ticket is "ready" through T's own board (its column roles), never across teams.
- Claims stay per ticket (`claimed_by_key_id`), so an assignment is the existing `claim_ticket` call made through the worker's key, subject to the same scope check.
- A ticket of a project that spans teams is offered by the team that owns the ticket, to that team's workers; the project never routes work.
- Events a worker sees are the team's own `events` (and later a workspace cursor over `workspace_events`, for teams it belongs to only).
