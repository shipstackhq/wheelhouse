# The move from Next.js to NestJS + React (history)

Epic WH-87, reasoning in ADR-16, finished in WH-102. This page is a short record of what happened and where the old app lives now. The working rules used while the migration ran (the freeze, the frozen schema and API contract, the worktree routine) are no longer in force.

## What changed

| Before | After |
|---|---|
| One Next.js app: pages, server actions, `/mcp`, `/api/v1`, webhooks and streams in one process | `apps/api` (NestJS) serves `/mcp`, `/api/v1`, `/api/app`, the GitHub webhook and connect flow and the live streams, and also serves the React build |
| UI in `src/app` and `src/components`, 59 server actions | `apps/web` (React, Vite, React Router, TanStack Query) talking to `/api/app` through `@wheelhouse/api-client` |
| Schema, service layer and libraries in `src/` | `packages/core`: schema, migrations, service layer, tools, sync, GitHub, the framework-free libraries |

The data was moved by an exact export and import (`docs/cutover.md`), rehearsed on copies of the real data. The URLs, API key hashing, cookie names and environment variables did not change, so the plugin, the CLI, the GitHub App and existing keys needed no reconfiguration.

## The old app is archived, not deleted

- Tag **`archive/next-app`** is the last commit that contains the Next app. Tag **`pre-migration`** (`e589073`) is the state just before the migration began.
- To look at it or run it again:

```bash
git worktree add ../wheelhouse-old archive/next-app
cd ../wheelhouse-old && pnpm install
PGLITE_DIR=<a COPY of a data directory> pnpm exec next dev -p 3456
```

  PGlite allows one process per data directory: never point the old app at a directory another process is using, and use a copy, not the live one. The old app takes a database made by the new one only if the schema is the same (`docs/cutover.md`, "Rollback").
- Nothing on `staging` or `production` imports it. It is not a workspace package, it is not built, and it is not tested in CI.
- **Rollback window:** the old container image and the data copies taken at cutover are kept until the date the owner records on WH-87. After that date they can be removed; the archive tag stays.

## What the migration left behind

- `tests/isolation.test.ts` and `tests/invites.test.ts` are the database suites that used to sit in `src/lib`. The isolation audit now walks `packages/core/src` and `apps/api/src`.
- `tests/contract/` is the HTTP contract suite, run against the NestJS API by default (`pnpm test:contract`).
- `docs/ui-api.md` keeps the inventory of the 59 server actions and the endpoint that replaced each, as a record.
- `docs/reanchor-rules.json` records how Next paths map to the new layout; `pnpm map:reanchor` uses it to move map nodes and docs.

## Work parked at the freeze

Tickets that were in Review when the freeze started were left where they were: WH-20, WH-21, WH-22, WH-23, WH-51, WH-64, WH-65, WH-69, WH-82, WH-83, WH-84, WH-86. Everything in Todo and Backlog outside the migration was untouched. The GitHub App (WH-20) had not yet been run against real github.com.
