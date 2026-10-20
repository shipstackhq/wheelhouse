# Contract tests

Black-box HTTP tests for the part of Wheelhouse that other things depend on: `/mcp`, `/api/v1/*`, `/api/webhooks/github`,
`/api/github/install`, `/api/github/callback`, `/api/stream`, `/api/teams/:key/stream`, `/api/health`, the `wh_session`
cookie and API-key authentication. The Claude Code plugin, the CLI, the GitHub App and existing API keys rely on these, so
they are frozen during the NestJS + React migration (ADR-16, WH-87). The suite is the pass condition for the new API.

It speaks plain HTTP and imports nothing from the app (only the seed does, to create accounts), so the same tests run against
any server that implements the contract.

## Run

```bash
pnpm test:contract                                  # seeds a throwaway database, starts the app, runs everything, cleans up
pnpm test:contract --only webhook,v1                # only test files whose name contains one of these
pnpm test:contract --server-cmd "pnpm --filter @wheelhouse/api start"   # the default server command; pass another to test a different server ({PORT} is replaced)
pnpm test:contract --suite app                      # only the web app's API (/api/app)
pnpm test:contract --suite frozen                   # only the external contract
pnpm test:contract --update-golden                  # accept a deliberate contract change (review the diff in golden/)
pnpm test:contract --keep                           # keep tests/contract/.work (databases, server logs) for inspection
```

It runs two passes: the server with the GitHub App pointed at a fake GitHub, then a server with no GitHub App at all
(`github-unconfigured`). About a minute: it starts the NestJS API on a throwaway database.

## Against a server you started yourself

```bash
pnpm test:contract prepare --dir tests/contract/.work/mine --fake-port 4599   # seeds; writes server.sh and server.env
. tests/contract/.work/mine/server.sh && <start your server on any port>      # it must use this database and GitHub config
pnpm test:contract --base-url http://127.0.0.1:3460 --fixtures tests/contract/.work/mine/fixtures.json --fake-port 4599
```

The server must use the seeded database (`PGLITE_DIR` or `DATABASE_URL` from the env file) and the fake GitHub's address for
`GITHUB_API_URL` and `GITHUB_WEB_URL`. Never point it at a database that holds real data: the tests create and change issues.

## What is in here

| File | Covers |
|---|---|
| `mcp.contract.test.ts` | JSON-RPC protocol, auth, rate limit, the tool list and prompts (golden), tool errors |
| `v1.contract.test.ts` | REST envelope, error codes, issue lifecycle, optimistic locking, roles in `move_issue`, sessions |
| `auth.contract.test.ts` | `wh_session` cookie, API keys, suspended workspaces, key-over-cookie precedence |
| `isolation.contract.test.ts` | one workspace cannot read or change another's data |
| `webhook.contract.test.ts` | signatures, framing, idempotency, push, pull request, CI, two workspaces sharing a repository id |
| `github-connect.contract.test.ts` | install redirect, state cookie, callback checks, ownership, takeover |
| `github-unconfigured.contract.test.ts` | the same routes on a server with no GitHub App |
| `stream.contract.test.ts` | SSE headers and events, resume, workspace and team scoping, the 12-streams-per-person cap, no slot leaks |
| `health.contract.test.ts` | liveness |
| `csrf.app.contract.test.ts` | **suite `app`:** forged and cross-site requests to the web app's API are refused, tokens are bound to a session |
| `web-api.app.contract.test.ts` | **suite `app`:** sign in, sign up, sign out, who am I, teams; cookie attributes; rate limits; error envelopes |
| `client.app.contract.test.ts` | **suite `app`:** the typed client over real HTTP |

The default is `--suite all`. `--suite frozen` runs only the external contract (`/mcp`, `/api/v1`, webhooks, GitHub connect, streams: what the plugin, the CLI and the GitHub App depend on). `--suite app` runs only the files named `*.app.contract.test.ts`, the web app's own API (`/api/app`). The Next app that used to meet the frozen contract is archived (tag `archive/next-app`).

## Golden files

`golden/` records what must not drift: the tool names, input schemas and read-only hints (descriptions are not recorded, so
rewording one does not fail the suite), the `initialize` result, the prompt list, and the *shape* of the core responses (keys
and types, not values). Adding, removing or changing a tool fails the suite until `--update-golden` is run and the diff is
reviewed.

## Deliberately not covered

- **Login, signup and logout.** In the Next app these were server actions, not HTTP routes, so they were never part of the frozen external contract; they are tested as `/api/app/auth/*` in suite `app`.
  The contract is the cookie they produce; the seed writes sessions directly. The new UI endpoints replacing them are WH-93.
- **The web pages** themselves; that is the job of the page-port issues.
- **`/api/health` returning 503** when the database is down.
