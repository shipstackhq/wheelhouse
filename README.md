# Shipstack Wheelhouse

Kanban boards and architecture maps that a small team **and its AI agents** share.

- **Board**: drag-and-drop tickets, markdown descriptions, comment threads, priorities, labels, "AI-ready" flag.
- **Map**: React Flow architecture graph. Services contain nested modules/components (drill in), edges show dependencies, each node carries markdown details and the tickets touching it.
- **AI loop**: every human or agent change is written to an append-only event log. Each agent API key has its own cursor into it, so `get_changes` returns exactly what the team did since the agent last looked. Agents write back through the same tools, and their work shows up on the board live with a 🤖 badge.
- **Claude integration**: a remote MCP server at `/mcp`, plus the same operations over REST at `POST /api/v1/<tool>`.

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

## Deploy (Vercel + Neon/Supabase)

1. Create a Postgres database and copy its connection string.
2. Import the repo in Vercel and set these env vars:
   - `DATABASE_URL`: the Postgres URL (use the pooled URL on Neon)
   - `APP_URL`: e.g. `https://wheelhouse.shipstack.run` (used in the setup snippets)
3. Deploy. Migrations in `drizzle/` run automatically on the first request.

PGlite is for local development only. Serverless deployments must set `DATABASE_URL`.

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
