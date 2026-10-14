# Shipstack Wheelhouse

Kanban boards and architecture maps that a small team **and its AI agents** share.

- **Board**: drag-and-drop tickets, markdown descriptions, comment threads, priorities, labels, "AI-ready" flag.
- **Knowledge map**: React Flow canvas with four linked zoom levels:
  - **Concepts**: what the product does
  - **Systems**: what runs where
  - **Data**: the schema as an ER diagram (tables, columns, foreign keys with crow's-foot cardinality)
  - **Code**: where it lives

  Levels are connected by `implements` links. Select a node and switch level to see what realizes it.

  Each node has a structured explainer (purpose, responsibilities, interfaces, gotchas) plus code anchors. **Flows** play step by step across the map. **Decisions** (ADRs) and a **Glossary**, with hover definitions, hang off nodes.
- **Freshness**: `report_changes` (from agents or a post-commit hook) flags the most specifically anchored node per layer as stale. Stale nodes show on the map and in agents' queues until they're re-described.
- **Ask**: Claude answers questions about the system from the map (`ANTHROPIC_API_KEY` required; uses `claude-opus-5-5`).
- **AI loop**: every human or agent change is written to an append-only event log. Each agent API key has its own cursor into it, so `get_changes` returns exactly what the team did since the agent last looked. Agents write back through the same tools, and their work shows up on the board live with a 🤖 badge.
- **Claude integration**: a remote MCP server at `/mcp`, plus the same operations over REST at `POST /api/v1/<tool>`.

## CLI and Claude Code plugin

The `wheelhouse` CLI (`@shipstack/wheelhouse-cli`), the Claude Code plugin, and the guide for AI agents live in their own repo: [shipstackhq/wheelhouse-cli](https://github.com/shipstackhq/wheelhouse-cli).

## Run locally

```bash
pnpm install
pnpm seed      # optional: demo@wheelhouse.local / wheelhouse-demo + prints an API key
pnpm dev
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

Wheelhouse runs as a single container on a VPS behind your own Caddy, using a Postgres you already have. Pushes to `main` build and deploy it automatically. See [docs/deploy.md](docs/deploy.md) for the one-time server setup, the GitHub secrets, rollback and backups.

`DATABASE_URL` is required in production; the embedded PGlite database is for local development only.

## Layout

```
src/db/schema.ts        Drizzle schema (users, teams, tickets, nodes, edges, events, agent_cursors…)
src/lib/service.ts      single write path: team scoping, optimistic locking, event emission
src/lib/tools.ts        tool registry → exposed via /mcp and /api/v1/<tool>
src/app/mcp/route.ts    stateless MCP (Streamable HTTP, JSON responses)
src/app/actions.ts      server actions for the UI
src/app/(app)/p/[key]   board, ticket drawer, map, activity
```

Schema change: edit `schema.ts`, run `pnpm db:generate`, then commit the new file in `drizzle/`.

## MVP limits

There are no invite emails or password reset: owners add members, who get a temporary password. Live updates use 3s polling. Each user belongs to one team.
