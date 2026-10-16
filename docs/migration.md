# Migration to NestJS + React

Plan: epic WH-87. Reasoning: ADR-16. This file is the working rules while the migration runs; it is deleted or reduced to a history note when the migration finishes (WH-102).

## The freeze

Every ticket outside the migration (WH-87 to WH-102) is frozen until cutover. Board bookkeeping for migration work (comments, moves, map updates) continues. Do not start, claim or move non-migration tickets.

## What must not change

1. **Database schema.** Drizzle schema and migrations 0000 to 0013 are ported unchanged. If a change is unavoidable it must be additive and agreed first, in a comment on WH-87.
2. **External contract.** Paths `/mcp`, `/api/v1/*`, `/api/webhooks/github`, `/api/github/install`, `/api/github/callback`, `/api/stream`, `/api/projects/[key]/stream`, `/api/health`; tool names and response shapes; cookie names; API key hashing; environment variables. The plugin, CLI, GitHub App and existing API keys must keep working with no reconfiguration.
3. **Behaviour.** The contract suite (WH-89) and the existing unit, isolation and database tests must keep passing.

## Where things live

Three checkouts of one repository (`/Users/atharvamalji/Projects/saas/`):

| Folder | Branch | Purpose | Port | Data |
|---|---|---|---|---|
| `wheelhouse-old` | detached at tag `pre-migration` | The old Next.js app: the **control plane** the board, map and ADRs live in. Never edit. | 3456 | `wheelhouse/.data/pglite` (the live data) |
| `wheelhouse-migration` | `migration/nest-react` | The integration branch. | 3460 (Nest), 5173 (Vite) | its own copy in `.data/pglite` |
| `wheelhouse` | `main` | Left as it was at the baseline. Holds the live data directory. Do not edit or delete. | none | `.data/pglite` is the live data |

Job worktrees are created off `migration/nest-react`, one per ticket:

```bash
cd /Users/atharvamalji/Projects/saas/wheelhouse-migration
git worktree add ../wh-job-WH-90 -b wh/WH-90-monorepo migration/nest-react
```

PRs go into `migration/nest-react`, never `main`. Name the branch or PR title with the ticket ref (`WH-90`) so the GitHub App links it. A branch named just `migration` is not allowed: it would block `migration/...` names.

Every new worktree needs its own `pnpm install` and a copy of `.env.local` (git-ignored). Give each running instance its own port and its own copy of the data directory.

## Running the old app

```bash
cd /Users/atharvamalji/Projects/saas/wheelhouse-old
PGLITE_DIR=/Users/atharvamalji/Projects/saas/wheelhouse/.data/pglite pnpm exec next dev -p 3456
```

PGlite allows **one process per data directory**. Stop the old app before touching its data; never point two processes at the same directory. To restart after a migration of the old app (there should be none), stop it gracefully (SIGTERM) so PGlite flushes.

## What never to touch

- `wheelhouse-old` (the checkout) and `wheelhouse/.data/pglite` (the live data), except by running the old app as above.
- The GitHub App settings and webhook URL. The new app must serve the same paths.
- `main`, until the final merge in WH-102.

## How the Wheelhouse plugin behaves in these worktrees

Checked from `wheelhouse-migration` (WH-88):

- `wheelhouse.json` is committed and points at `http://localhost:3456`, project `WH`, so every worktree talks to the old app. That is intended.
- The git hooks are shared by all worktrees (`.git/hooks`), and the plugin finds the repo root with `git rev-parse --show-toplevel`, so each worktree is its own root.
- `.wheelhouse/` (briefing, session state, hook log) is git-ignored and **per worktree**: a fresh worktree starts without it and gets one at the first session or `wheelhouse context`.
- **Landing only counts on the default branch (`main`).** Commits on `migration/nest-react` and `wh/*` branches do not flag map nodes stale or publish drafts in the old app. This is intended; the map is re-anchored in WH-101.
- The API key is shared (`~/.config/wheelhouse/credentials.json`), so all worktrees act as the same agent key.

## Baseline and rollback

- Tag `pre-migration` (commit `e589073`) is the last state before the freeze: all migrations up to 0013 are committed.
- The old app plus an untouched copy of the live data is the rollback path until WH-102 ends the rollback window.

## Work parked at the freeze

Tickets that were in Review when the freeze started, left as they were (not moved):
WH-20, WH-21, WH-22, WH-23, WH-51, WH-64, WH-65, WH-69, WH-82, WH-83, WH-84, WH-86.
Everything in Todo and Backlog outside the migration is untouched. WH-20 (GitHub App) has still not been run against real github.com.

## Repository layout after WH-90

```
packages/core     @wheelhouse/core: schema, migrations, service layer, tools, sync, GitHub, the framework-free libraries
apps/api          the NestJS API: /mcp, /api/v1, /api/health (WH-91); webhooks, GitHub connect and streams in WH-92
apps/web          empty until WH-94 (React)
src/              still the Next.js app (pages, server actions, components) until the cutover
```

- Import core as `@wheelhouse/core/db`, `@wheelhouse/core/db/schema` and `@wheelhouse/core/lib/<module>` (including `lib/github/<module>`). Inside core, use relative imports. Core must not import `next/*`, `react`, `server-only`, `@/components` or `@/app`; the type check and `grep` in the WH-90 acceptance criteria enforce it.
- Migrations live in `packages/core/drizzle` and are frozen (0000 to 0013). `pnpm db:generate` must report no changes. Set `WHEELHOUSE_MIGRATIONS_DIR` to point a process somewhere else; otherwise `./packages/core/drizzle` and `./drizzle` are tried from the working directory.
- `pnpm test` runs core's tests, then the app's. `pnpm typecheck` checks the whole tree and then core on its own. `pnpm test:contract` is the HTTP contract suite (WH-89); it also takes `--database-url` to run against a real Postgres.
- `src/lib` keeps only what belongs to the Next app: `auth.ts` (cookies and redirects), `stream-route.ts`, and UI helpers (labels, history groups, map layout and collapse, the markdown editor setup, navigation progress, ticket navigation, the browser side of the live stream). `isolation.test.ts` and `invites.test.ts` stay there because they audit the app's own files; the isolation audit walks `src` and `packages/core/src`.
- Core has no per-request cache. The Next app registers React's `cache()` for the dashboard's shared query in `src/lib/core-host.ts`; the API does not need it.
- Run the API with `pnpm --filter @wheelhouse/api start` (port 3000 by default; use 3460 next to the old app). Check it with `pnpm test:contract --only health,mcp,v1,auth,isolation --server-cmd "pnpm --filter @wheelhouse/api start"`. Authentication, the MCP protocol and the error shapes are in `@wheelhouse/core` and shared with the Next app; change them there, once.
