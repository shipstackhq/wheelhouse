# Moving the data and cutting over (WH-100)

> **Four additive migrations came after the freeze: 0014 (WH-103, `docs.labels`) and, for WH-105, 0015 (project members and the access audit log), 0016 (`invites.projects`) and 0017 (`sessions.active_workspace_id`), and `db:import` refuses a target whose migrations differ from the export's.**
> Before exporting, bring a **copy** of the source database to this code's migrations with `pnpm db:migrate --to <copy>` (all are additive; 0015 also gives every current member access to the projects they could already see,
> so the old app keeps working on a database that has them). Otherwise the import stops with "the target's migrations (18) are not the export's (14)".

> **Then the foundation migrations 0018 to 0022 (WH-111 to WH-115) changed the schema on purpose**, so moving data from a database made before them needs the section *The foundation migrations* below, not just `db:migrate`.

The schema was frozen for the move (migrations 0000 to 0013, plus the additive 0014 to 0017 above), so moving Wheelhouse from the Next app to the Nest + React app is a **copy of the data**, not a
transform. The tools below copy it exactly, prove they did, and never write to the original. They also move data between PGlite and Postgres in
either direction, so the same procedure covers the local control plane (PGlite, port 3456) and a server (Postgres, `docs/deploy.md`).

## The foundation migrations (0018 to 0022, WH-111 to WH-116)

These rename the tenant to **workspace** and today's project to **team** (the word *project* is free for the later deliverable), tie every team-scoped row to its
workspace with composite keys, add unique keys, parent keys and a CHECK for every enum column, and turn three JSON arrays (ADR nodes, ticket labels, invite teams)
into rows. A database made before them is brought across like this, **always on a copy**:

```
pnpm db:migrate --to <copy> --through 0020      # the state just before the constraints; applies 0018 (workspaces), 0019 (teams), 0020 (workspace keys)
pnpm db:preflight --to <copy>                   # read only: every row the new constraints would refuse, named
pnpm db:preflight --to <copy> --resolve         # only if it listed dangling references: removes exactly those entries, saying each one
pnpm db:migrate --to <copy>                     # 0021 (constraints) and 0022 (join tables); a dangling reference makes 0022 stop with nothing changed
```

What the preflight can list, and what to do with it:

| Finding | What it means | Fix |
|---|---|---|
| `decisions.node_ids` names a node that is not there | an ADR still pointed at a map node that was deleted (the JSON array never cleaned itself) | `--resolve` removes the entry; or relink the ADR to the node that replaced it first (`upsert_decision`) |
| `invites.teams` names a team that is gone or of another workspace | a stale grant on an old invite | `--resolve` removes the grant |
| two teams of one workspace share a key, any case; two users share an email, any case; two columns share a role | the new unique keys cannot be built | fix by hand (rename or merge): the tool never deletes rows |
| a value outside an enum (a role, status, kind…) | the CHECK would refuse it | fix by hand |

Two data effects of 0020 are not preflight findings, because they are the point of the migration: a `team_members` row for someone who is not a member of that workspace is
deleted, and a ticket assigned to someone who is not on the ticket's team is unassigned. Both are rare; look at the real database for them before the day.

The address of a team is now `/t/<KEY>/…` (was `/p/<KEY>/…`) and its API `/api/app/teams/…` (was `/api/app/projects/…`), the team stream `/api/teams/<KEY>/stream`.
**Links printed by the plugin and CLI that still say `/p/` stop working** (no compatibility shim; dev only). `/api/v1` and the MCP are unchanged: the tool names, the `project`
argument and every response shape stay, and `runTool` in `packages/core/src/lib/tools.ts` is the one place that maps them.

The rehearsal script below does all of this on a copy (steps 0 and 0b) and then the same checks as before on the new schema.

## The tools

```bash
pnpm db:migrate --to <PGlite directory | postgres://…>                       # a COPY of the source, brought to this code's migrations (see below)
pnpm db:export --from <PGlite directory | postgres://…> --out <folder>
pnpm db:import --in <folder> --to <PGlite directory | postgres://…>
pnpm db:verify --in <folder> --to <target>            # the target against what the export said the source held
pnpm db:verify --from <source> --to <target>          # two databases directly
```

- **Migrate (WH-105)** applies this code's migrations to a database. The export keeps the source's migrations and the import refuses a target at different ones, so a source made by older code is **copied, and the copy migrated**, before it is exported. Never run it on the live database. Migration 0015 (WH-105) also **backfills project access**: every current member becomes an editor of every project of their team and each team owner its project admin, so nobody loses access on the day (ADR-23). `scripts/rehearse-data-move.sh` does this as its step 0.
- **Export** reads every table (31, in dependency order) as one JSON line per row, as of one moment, plus a `manifest.json`: rows and a content checksum per
  table, the sequences, the applied migrations. Rows are `to_jsonb(row)` text and are never parsed in JavaScript, so a bigint past 2^53, a double, a
  microsecond timestamp or an emoji comes out as it went in. A PGlite source directory is **copied first and the copy is opened**: the original is
  never opened, so nothing in it can change (a test checks this). Postgres is read in one read-only transaction.
- **Import** goes into a database that has just been migrated by this code (the tool does that) and is **empty**. It refuses anything else: a target
  with data in it, or at different migrations. It is one transaction, so a failure leaves the target empty and the import can simply be run again. Then
  every sequence is set exactly where the source had it (so `events.seq`, which every agent cursor depends on, never reuses a number).
- **Verify** recomputes the checksums on the target and compares them with the manifest (or with a second database), then checks things that must be true of
  any Wheelhouse database: every foreign key resolves, `events_seq_seq` is not behind the newest event, no agent or session cursor is ahead
  of the newest event, every API key hash and session id is a sha256, and it reports the users, teams and memberships. Exit status 0 means
  "everything agrees"; anything else is non-zero and names the table.

### The map and the docs after the move (WH-101)

Map nodes and docs carry **anchors** (paths and globs such as `src/lib/service.ts`, `src/db/**`, `src/db/schema.ts#docs`) and the content hashes of the code when they were described. Moving files to `packages/core`,
`apps/api` and `apps/web` would leave anchors pointing at nothing, and a baseline that is not carried over would flag nodes as stale for files that did not change. Two tools fix that, on the **imported data**:

```bash
pnpm map:reanchor --db <target> --from pre-migration --to HEAD --rules docs/reanchor-rules.json            # dry run: reports, writes nothing
pnpm map:reanchor --db <target> --from pre-migration --to HEAD --rules docs/reanchor-rules.json --apply    # rewrites anchors and baselines
pnpm map:after-migration --db <target>                                                                     # what the map SAYS (descriptions, structure, ADRs)
```

- `map:reanchor` takes what git says moved between the two refs (renames, even with edits) and `docs/reanchor-rules.json` for what git cannot know (a Next page rewritten as a React page is a new file, not a rename). An anchor is **kept**,
  **rewritten** (a `#symbol` suffix and a `repo:` qualifier survive; one anchor may become several), or reported as **unmapped** or **dangling** and left alone; the exit status is non-zero if any is. A baseline follows the files that moved
  (so a file that really changed still shows as changed at the next landing); a row whose anchors were rewritten by a rule starts with none, so the next landing records one instead of flagging every new file. Paths in a stale reason move with the
  files, never twice. It only touches the project named in the rules file (other projects' anchors name other repositories), and also rewrites the anchors in drafts waiting to be published. Running it again plans nothing.
  **It is also the check for "no anchor points at a path that no longer exists"**: a dry run exits 0 only if every anchor matches a file in the tree you name. Run it again after the Next app is removed (WH-102), with `--to HEAD` of that commit.
- `map:after-migration` is the part that is about meaning, through the service layer (so each change is an event and a node edited here is baselined at the next landing): `web` becomes the React app; new `API` (NestJS) and `core` services, and the API's
  modules (Web app API, GitHub webhook and connect, Live streams); `MCP server` moves inside `API` and `Service layer` inside `core`; the connections follow (web → API → core → Postgres, the UI components → Web app API, GitHub → the webhook module);
  notes and one flow that said "server action" are corrected; ADR-16 is recorded as implemented and the packaging sentence in the API's ADR is settled; two new ADRs record why one process serves both apps and why versioned edits lock the row; two glossary terms are added.
  It never overwrites a sentence someone has since edited by hand (it reports it), and a second run changes nothing. It does not need a git repository.

When the new layout reaches the branch Wheelhouse tracks (`docs/branches.md`) and lands (the plugin's hooks on a merge, or the webhook), the first landing records the baselines the re-described nodes do not have yet, and flags only files that really changed since a node was described.

Both are rehearsed on every run of the rehearsal script below. They are applied on the **cutover day to the imported copy, not to the running control plane**: until the cutover the live map must keep describing `main`, which is still the Next app, and a
landing only counts on `main`. The map events they create (about 35 for the real data) will appear in each agent's queue as changes by the owner, which is right: agents should hear that the architecture description changed.

Checksums are the md5 of a table's rows as JSON in byte order of that text, so they do not depend on collation or storage order. PGlite → Postgres → PGlite
is tested to be the identity (`packages/core/src/tools/db-copy.test.ts`, with a real Postgres in CI).

Scale: a table is read into memory at once, which is fine for Wheelhouse (about 3,200 rows and 6 MB exported for the real data). It would need batching for a database a thousand times larger.

## Rehearsals

`scripts/rehearse-data-move.sh <PGlite directory> [name]` is one full rehearsal on a copy, timed, in about a minute. It runs, and logs under `.work/rehearsal-<name>/`:

0. a copy brought to migration 0020, **0b. the preflight** (reported, then resolved with `--resolve` if it found dangling references, and clean after that) and migrations 0021 and 0022;
1. export; 2. import into a fresh PGlite directory; 3. verify against the export **and** against the source directly;
4. the same into a throwaway Postgres 18 (Docker) and back to PGlite, which must equal the source;
5. **continuity**, with the new app started on the copy using the same `.env.local` as the old one: the person's real API key (from
   `~/.config/wheelhouse/credentials.json`) authenticates; in every project the key resumes at exactly its cursor with exactly the number of changes waiting
   that the data says (not a replay from zero); a pull_request webhook, signed with the real webhook secret, for the repository that is really connected,
   naming an open ticket, is handled and matched to its project; the same process serves the React app;
6. the **whole contract suite** (326 + 6) against the app on the imported copy (its fixtures are added to the copy);
7. (in the script after step 4) **4b**: the database suites (queue, invites, admin, isolation, version lock, db-copy, workspace scope, constraints, join tables, cycles, projects, initiatives) against the Postgres 18 that holds the imported data, as CI runs them;
8. the **image** builds, starts against a fresh Postgres, serves the React app at `/t/…`, answers 401 on the web API signed out and has applied every migration (skip with `REHEARSAL_SKIP_IMAGE=1`).

`REHEARSAL_BASE=<git ref>` is the code the map was last anchored to (default: where the branch left `staging`), used by the re-anchoring in step 5; `REHEARSAL_RESOLVE=0` makes dangling references fail the rehearsal instead of being resolved.

| | Source | Export | Import | Verify | Postgres and back | Continuity | Contract | Total | Result |
|---|---|---|---|---|---|---|---|---|---|
| 1 | snapshot of the real data, 2026-10-17 | 2s | 1s | 3s | 7s | 5s | 41s | 60s | passed, but see below |
| 2 | same snapshot | 1s | 2s | 2s | 8s | 7s | 42s | 62s | passed |
| 3 | a fresh snapshot | 2s | 1s | 3s | 8s | 5s | 39s | 58s | passed, no discrepancies |
| 4 | another fresh snapshot (after the script gained the "serves the React app" check) | 1s | 2s | 2s | 8s | 5s | 39s | 57s | passed, no discrepancies |
| 5 | the same snapshot as 4, with the map re-anchored and re-described on the copy before the app starts (WH-101) | 2s | 1s | 2s | 10s | 13s | 39s | 68s | passed: 25 nodes and docs re-anchored, 32 changes to the map, integrity holds, the key resumes at its cursor (WH: 46 changes waiting, the 34 new ones are the map update), contract suite 311 + 6 |

The source of these four is `wheelhouse-migration/.data/pglite`, the copy of the live data the migration has used since it began (3,186 rows in 29 tables, newest
event 2421, four agent cursors, six API keys, two teams). **None of them used the live directory** (`wheelhouse/.data/pglite`, owned by the running
control plane on 3456), which was not touched. A rehearsal on a fresh copy of the live data is the first step of the real cutover below.

Problems found, all in the rehearsal script, none in the data tools:
- The cursor check in run 1 passed without checking anything: it read `changes` at the top of the response, but `/api/v1` wraps results in `data`, so it always saw
  zero changes. Found by strengthening the check (compare the server's `cursor` and `total` with what the data says); it then failed for the same reason until fixed,
  and run 2 passed with the real check (for example WH: cursor 2352, 12 changes waiting, as the data says).
- `list_projects` also answers in `data`; the printout was wrong, not the check.
- Runs 1 and 2 used one snapshot; runs 3 and 4 each used a fresh one.

## Cutover runbook: the local control plane (PGlite, port 3456)

Owners: **O** the person who owns Wheelhouse (does the steps that stop and start things), **C** Claude (runs the tools and the checks when asked). Times are from the
rehearsals plus time to read each answer; the whole thing is about 20 minutes, and nothing can be lost because the old directory is never written to.

Before the day (**O**, **C**): the last rehearsal on a fresh copy passed (`scripts/rehearse-data-move.sh`); `main` has what you will run (WH-102, removing the Next app, is
held until the new app has been live and trusted); the old app is still at `wheelhouse-old` (tag `pre-migration`).

| When | Owner | Step |
|---|---|---|
| T-30 min | O | Tell anyone sharing it that the board stops for about 15 minutes. Finish or commit agent work in flight. |
| T-10 | O | Stop agents and sessions: close Claude Code sessions that use the board (their changes are in `events`; their cursors move with the data). |
| T-5 | O | `lsof -ti :3456 -sTCP:LISTEN \| xargs kill` (SIGTERM, so PGlite flushes). Wait until the port is free. **Never `pkill -f next-server`.** |
| T+0 | O | A safety copy that nothing will ever touch: `cp -R wheelhouse/.data/pglite ~/wheelhouse-pglite-before-cutover-$(date +%Y%m%d)`. |
| T+1 | C | **Rehearse once more on that copy** (about a minute): `scripts/rehearse-data-move.sh ~/wheelhouse-pglite-before-cutover-… final`. Must say `PASSED`. |
| T+3 | C | Final export: `pnpm db:export --from wheelhouse/.data/pglite --out ~/cutover/export` (copies first; the original is not opened). |
| T+3 | C | Import into a **new** directory: `pnpm db:import --in ~/cutover/export --to ~/cutover/pglite`. |
| T+4 | C | `pnpm db:verify --in ~/cutover/export --to ~/cutover/pglite` and `pnpm db:verify --from wheelhouse/.data/pglite --to ~/cutover/pglite`. Both must say `RESULT: everything agrees`. **Stop here if either does not.** |
| T+5 | C | **The map:** `pnpm map:reanchor --db ~/cutover/pglite --from pre-migration --to HEAD --rules docs/reanchor-rules.json --apply` (must exit 0: no unresolved anchor), then `pnpm map:after-migration --db ~/cutover/pglite`, then `pnpm db:verify --to ~/cutover/pglite --integrity-only`. Read the list it prints. (Skip this row to cut over with the map as it was; do it before the new app first starts, never after.) |
| T+6 | O/C | Build the React app and start the new app on the same port, with the same `.env.local`: `pnpm --filter @wheelhouse/web build && PGLITE_DIR=~/cutover/pglite PORT=3456 pnpm --filter @wheelhouse/api start`. |
| T+7 | O/C | Smoke test: the URL is the same (`http://localhost:3456`), so the plugin, the CLI and the credentials file need no change. Run `get_briefing` from a Claude Code session; the key must work and the queue must continue where it was (the rehearsal's continuity check). Sign in in the browser as yourself; open the board, the map and the docs; create and move a ticket; link a node. |
| T+11 | O | If the GitHub App is reachable (it is not on localhost): open a pull request naming a ticket and watch it move. |
| T+16 | O | Announce it is back. Keep `~/wheelhouse-pglite-before-cutover-…` and `wheelhouse-old` untouched for as long as you want the option below. |

**Rollback** (any time, no matter how far you got): stop the new app (`lsof -ti :3456 -sTCP:LISTEN | xargs kill`), then start the old app on the **original, never-written** directory,
as `docs/migration.md` describes: `cd wheelhouse-old && PGLITE_DIR=<wheelhouse/.data/pglite> pnpm exec next dev -p 3456`. Nothing about the old directory changed. To keep what was written on the
new side before rolling back, export the new directory and import it into a **fresh** directory, then start the old app on that one (same schema, so the old app takes it):
`pnpm db:export --from ~/cutover/pglite --out ~/cutover/export-back && pnpm db:import --in ~/cutover/export-back --to ~/cutover/pglite-back`.

After the cutover (**C**, a day later): compare the row counts the verify step printed at T+4 (tickets, comments, ADRs, docs, map nodes) with what the board, the map and the docs show now,
and check the plugin's queue. The new directory has been written to since, so counts can only have grown. Only then is it reasonable to consider WH-102 (taking the Next app out of the tree). It is **archived, not deleted**: the last commit that contains it is tagged `archive/next-app` (`pre-migration` marks the state before the migration), so the old app can always be checked out again (see `docs/migration.md`).

## The same on a server (Postgres)

`docs/deploy.md` covers the server. To move data into its Postgres: create the database and role as in *One-time server setup*, then `pnpm db:import --in <export> --to "postgres://wheelhouse:…@host/wheelhouse"` before the first
deploy (the tool migrates the empty database itself, and the app finds the migrations already applied), `pnpm db:verify` it, and deploy. The Postgres path was rehearsed on every run above (step 4).
