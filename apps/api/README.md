# @wheelhouse/api

The NestJS API (WH-91, part of the Next.js to NestJS + React migration, WH-87 / ADR-16). It serves, at the same paths as the Next app:

| Route | |
|---|---|
| `POST /mcp` | Model Context Protocol, stateless JSON-RPC (`GET` and `DELETE` answer 405) |
| `GET /api/v1`, `POST /api/v1/:tool` | REST over the same tools |
| `GET /api/health` | liveness and database check |

Webhooks, the GitHub connect flow and the live streams follow in WH-92; the JSON API for the web app in WH-93.

## Run

```bash
pnpm --filter @wheelhouse/api start      # PORT (default 3000), HOST (default 0.0.0.0)
pnpm --filter @wheelhouse/api dev        # restarts on change
```

The environment is the Next app's: `DATABASE_URL` (a real Postgres) or, without it, an embedded PGlite database in `.data/pglite` at the repository root (override with `PGLITE_DIR`). `.env.local` and `.env` at the repository root are read first; variables already set win. Migrations run at startup. `SIGTERM` closes the database cleanly.

## How it is built

- Everything that decides who may come in, what a tool does and how an error is shaped is `@wheelhouse/core`: `lib/auth-core`, `lib/mcp`, `lib/api-errors`, `lib/tools`. The Next app uses the same functions. Controllers only read the request and write the response; none touches the database, and the isolation audit fails if one does.
- ESM, started with `tsx`, no build step yet. `tsx` does not emit decorator metadata, so every injected dependency uses an explicit `@Inject(...)`.
- Request bodies are read as text by `http/raw-text.ts` and parsed in the handler, so authentication is judged before the body is.

## Test

`pnpm --filter @wheelhouse/api test` for the unit tests. The behaviour is checked by the contract suite from the repository root:

```bash
pnpm test:contract --only health,mcp,v1,auth,isolation --server-cmd "pnpm --filter @wheelhouse/api start"
```
