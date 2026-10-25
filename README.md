# Shipstack Wheelhouse

Issues (as a list or a kanban board, with sub-issues, statuses and priorities) and architecture maps that a small team **and its AI agents** share.

- **Issues**: a list or a drag-and-drop board of the same issues, grouped by status, priority, assignee, project or cycle; search and filters; sub-issues to any depth, with progress; statuses each team defines (several per stage, one the default, plus Canceled); markdown descriptions, comment threads, priorities, labels, "AI-ready" flag.
- **Knowledge map**: React Flow canvas with four linked zoom levels:
  - **Concepts**: what the product does
  - **Systems**: what runs where
  - **Data**: the schema as an ER diagram (tables, columns, foreign keys with crow's-foot cardinality)
  - **Code**: where it lives

  Levels are connected by `implements` links. Select a node and switch level to see what realizes it.

  Each node has a structured explainer (purpose, responsibilities, interfaces, gotchas) plus code anchors. **Flows** play step by step across the map. **Decisions** (ADRs) and a **Glossary**, with hover definitions, hang off nodes.
- **Freshness**: `report_changes` (from agents or a post-commit hook) flags the most specifically anchored node per layer as stale. Stale nodes show on the map and in agents' queues until they're re-described.
- **Ask**: Claude answers questions about the system from the map (`ANTHROPIC_API_KEY` required; uses `claude-opus-5-5`).
- **AI loop**: every human or agent change is written to an append-only event log. Each agent API key has its own cursor into it, so `get_changes` returns exactly what the workspace did since the agent last looked. Agents write back through the same tools, and their work shows up on the board live with a 🤖 badge.
- **Claude integration**: a remote MCP server at `/mcp`, plus the same operations over REST at `POST /api/v1/<tool>`.

## CLI and Claude Code plugin

The `wheelhouse` CLI (`@shipstack/wheelhouse-cli`), the Claude Code plugin, and the guide for AI agents live in their own repo: [shipstackhq/wheelhouse-cli](https://github.com/shipstackhq/wheelhouse-cli).

## Run locally

```bash
pnpm install
pnpm seed      # optional: demo@wheelhouse.local / wheelhouse-demo + prints an API key
pnpm build     # builds the React app (apps/web/dist)
pnpm start     # http://localhost:3000: the API, which serves the React app too
```

For development with hot reload, run the API and the Vite dev server side by side:

```bash
PORT=3460 pnpm dev                       # the NestJS API, restarts on change
pnpm --filter @wheelhouse/web dev        # http://localhost:5173, forwards /api and /mcp to the API on 3460
```

No database setup is needed locally. Without `DATABASE_URL`, the app uses embedded Postgres (PGlite) stored in `.data/`. Stop the app before running `pnpm seed`, because PGlite is single-process.

## Connect Claude Code

Create a key under **Agents & API keys**, then run:

```bash
claude mcp add --transport http wheelhouse http://localhost:3000/mcp --header "Authorization: Bearer wh_..."
```

The Agents page also gives you a CLAUDE.md snippet that tells the agent how to work the board.

## Mapping a codebase

The MCP server ships prompts that appear as slash commands in Claude Code:

- `/mcp__wheelhouse__map_codebase KEY` builds the map top-down: concepts, systems, code, flows, ADRs and glossary
- `/mcp__wheelhouse__map_schema KEY` maps the database schema (tables, columns, FKs, indexes, enums) from your schema/migration files
- `/mcp__wheelhouse__refresh_map KEY` re-describes stale nodes
- `/mcp__wheelhouse__explain KEY <topic>` explains a topic and fills gaps in the map

## Deploy

Wheelhouse runs as a single container on a VPS behind your own Caddy, using a Postgres you already have. Nothing deploys automatically yet: work lands on `staging` and is promoted to `production` ([docs/branches.md](docs/branches.md)). See [docs/deploy.md](docs/deploy.md) for the one-time server setup, the GitHub secrets, rollback and backups.

`DATABASE_URL` is required in production; the embedded PGlite database is for local development only.

## Layout

```
apps/api/src/db/schema.ts    Drizzle schema (users, workspaces, teams, issues, nodes, edges, events, agent_cursors…)
apps/api/drizzle/            migrations
apps/api/src/lib/service.ts single write path: access checks, optimistic locking, event emission
apps/api/src/lib/tools.ts   tool registry → exposed via /mcp and /api/v1/<tool>
apps/api                         NestJS: /mcp, /api/v1, /api/app, the GitHub webhook and connect flow, live streams; serves the React build
apps/web                         the React app (Vite): board, map, docs, decisions, glossary, workspace, agents
packages/api-client              the typed client the React app uses for /api/app
tests/                           the HTTP contract suite (tests/contract) and the database suites (isolation, invites)
docs/                            deploy, cutover, isolation audit, the web app's API, migration history
```

Schema change: edit `apps/api/src/db/schema.ts`, run `pnpm db:generate`, then commit the new file in `apps/api/drizzle/`.

The app used to be a single Next.js app. It is archived at the git tag `archive/next-app` (see [docs/migration.md](docs/migration.md)).

## Known limits

No email is sent: an invite is a link the inviter shares. There is no password reset yet (WH-73). Live updates use server-sent events and need a single app process. A person can belong to several workspaces, and a team is visible only to its members.
