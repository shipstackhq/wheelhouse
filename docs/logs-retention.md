# Logs, retention and storage per workspace

Status: **proposal**, 2026-10-26. Nothing built yet. Workspaces have no plan today; this doc assumes one is added.

## Why

We need to know how much storage a workspace uses, to cap it, and to price plans with margin. Product data (issues, the map, docs) grows
slowly and with intent. Logs grow with activity and without bound, so they are what we cap.

## What we measured (local demo workspace, 2026-10-26)

- The PGlite folder was 134 MB; after `VACUUM FULL` the database was **16 MB**. The live data of one lightly used workspace is ~15 MB.
- 117 MB of it was dead row versions in `work_sessions` (2 live rows). Every hook check-in rewrites the row's `files` jsonb, and PGlite has
  no autovacuum. On managed Postgres autovacuum keeps this flat, so it is a dev-only problem, not a storage cost.
- Log-like tables were small: `events` 1.6 MB, `chat_messages` 136 kB, `audit_events` 80 kB, device tables under 100 kB.

Not enough data to price from. We need growth per active workspace per month, under real use with daemon runs.

## What counts as a log

| Table | What it is | Expires? |
|---|---|---|
| `events`, `workspace_events` | The change feed agents read (`agent_cursors`, `work_sessions.last_seq`) | Yes |
| `device_job_events` | Step-by-step progress of a daemon run | Yes; the run row (`device_jobs`: state, cost, PR, summary) is kept |
| `device_messages` | Signed messages to devices | Yes, short |
| `audit_events` | Who did what, for admins and compliance | Yes, longer window |
| `github_deliveries` | Webhook deliveries | Yes, short |
| `notifications` | Inbox items | Yes, after read |
| `chat_messages` | A person's conversation | **No**: user content, deleted with the thread |
| Issues, comments, decisions, docs, the map | Product data | **Never** |

Expiring the feed is safe: an agent whose cursor is older than the window cannot replay and starts from now (the replay/skip flow for
removed sessions already handles this).

## The logs service

One module, `apps/api/src/modules/logs`, owns every rule above. Other modules keep writing their own rows; they do not know about retention.

1. **A registry.** One list: table, its timestamp column, and which retention class it is in (`feed`, `runs`, `audit`, `delivery`,
   `inbox`). Adding a log table is one line.
2. **Policy from the plan.** `retentionFor(workspace, class)` returns days, from the workspace's plan with an optional per-workspace
   override (an enterprise contract). The plan table is the only place the numbers live.
3. **A daily sweep.** For each workspace and each registered table, delete rows older than its window, in batches. Same shape as
   `daemon.sweep.ts`. Logs what it removed.
4. **Usage.** `usage(workspace)`: live bytes per table, `sum(pg_column_size(t.*))` grouped by `workspace_id`. Stored once a day in a small
   `workspace_usage` table, so we can see growth over time and warn near a cap.

The service never touches product data and never deletes a row that is not in the registry.

## Starting numbers

| Class | Free | Pro | Enterprise |
|---|---|---|---|
| `feed` | 30 days | 90 days | 1 year |
| `runs` (progress) | 30 days | 90 days | 1 year |
| `audit` | 90 days | 180 days | 1 year or contract |
| `delivery` | 7 days | 7 days | 30 days |
| `inbox` (read items) | 30 days | 90 days | 1 year |
| Storage soft cap | 1 GB | 10 GB | contract |

These are guesses to be checked against `workspace_usage` after a few weeks of real use. The soft cap warns; it does not block writes.

Storage on managed Postgres costs cents per GB-month. Compute and model usage drive margin far more, so storage is a guardrail, not the
price.

## Related fixes (separate from the service)

- `work_sessions`: skip the write when a file's hash has not changed, and update only the changed key in `files`. Optionally
  `fillfactor = 70` and a fixed autovacuum threshold on that table.
- Dev: `VACUUM` the PGlite database on boot so `.data/pglite` stays small.

## Open questions

- Where plans live (a `plan` column on `workspaces` vs a billing provider) is decided with billing, not here.
- Whether a workspace can export logs before they expire.
- Whether chat threads get their own plan limit later.
