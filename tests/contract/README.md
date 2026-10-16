# Contract tests

Black-box HTTP tests for the part of Wheelhouse that other things depend on: `/mcp`, `/api/v1/*`, `/api/webhooks/github`,
`/api/github/install`, `/api/github/callback`, `/api/stream`, `/api/projects/:key/stream`, `/api/health`, the `wh_session`
cookie and API-key authentication. The Claude Code plugin, the CLI, the GitHub App and existing API keys rely on these, so
they are frozen during the NestJS + React migration (ADR-16, WH-87). The suite is the pass condition for the new API.

It speaks plain HTTP and imports nothing from the app (only the seed does, to create accounts), so the same tests run against
any server that implements the contract.

## Run

```bash
pnpm test:contract                                  # seeds a throwaway database, starts the app, runs everything, cleans up
pnpm test:contract --only webhook,v1                # only test files whose name contains one of these
pnpm test:contract --server-cmd "pnpm --filter @wheelhouse/api start"   # a different server; {PORT} is replaced
pnpm test:contract --update-golden                  # accept a deliberate contract change (review the diff in golden/)
pnpm test:contract --keep                           # keep tests/contract/.work (databases, server logs) for inspection
```

It runs two passes: the server with the GitHub App pointed at a fake GitHub, then a server with no GitHub App at all
(`github-unconfigured`). About 30 seconds with `next dev`.

## Against a server you started yourself

```bash
pnpm test:contract prepare --dir tests/contract/.work/mine --fake-port 4599   # seeds; writes server.sh and server.env
. tests/contract/.work/mine/server.sh && <start your server on any port>      # it must use this database and GitHub config
pnpm test:contract --base-url http://127.0.0.1:3460 --fixtures tests/contract/.work/mine/fixtures.json --fake-port 4599
```

The server must use the seeded database (`PGLITE_DIR` or `DATABASE_URL` from the env file) and the fake GitHub's address for
`GITHUB_API_URL` and `GITHUB_WEB_URL`. Never point it at a database that holds real data: the tests create and change tickets.

## What is in here

| File | Covers |
|---|---|
| `mcp.contract.test.ts` | JSON-RPC protocol, auth, rate limit, the tool list and prompts (golden), tool errors |
| `v1.contract.test.ts` | REST envelope, error codes, ticket lifecycle, optimistic locking, roles in `move_ticket`, sessions |
| `auth.contract.test.ts` | `wh_session` cookie, API keys, suspended teams, key-over-cookie precedence |
| `isolation.contract.test.ts` | one team cannot read or change another's data |
| `webhook.contract.test.ts` | signatures, framing, idempotency, push, pull request, CI, two teams sharing a repository id |
| `github-connect.contract.test.ts` | install redirect, state cookie, callback checks, ownership, takeover |
| `github-unconfigured.contract.test.ts` | the same routes on a server with no GitHub App |
| `stream.contract.test.ts` | SSE headers and events, resume, team and project scoping, the 12-streams-per-person cap, no slot leaks |
| `health.contract.test.ts` | liveness |

## Golden files

`golden/` records what must not drift: the tool names, input schemas and read-only hints (descriptions are not recorded, so
rewording one does not fail the suite), the `initialize` result, the prompt list, and the *shape* of the core responses (keys
and types, not values). Adding, removing or changing a tool fails the suite until `--update-golden` is run and the diff is
reviewed.

## Deliberately not covered

- **Login, signup and logout.** They are Next server actions, not HTTP routes, so they are not part of the external contract.
  The contract is the cookie they produce; the seed writes sessions directly. The new UI endpoints replacing them are WH-93.
- **The web pages** themselves; that is the job of the page-port tickets.
- **`/api/health` returning 503** when the database is down.
