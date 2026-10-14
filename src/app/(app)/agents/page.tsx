import { headers } from "next/headers";
import { desc, eq } from "drizzle-orm";
import { requireHuman } from "@/lib/auth";
import { getDb, schema } from "@/db";
import { markAllSeenAction, revokeApiKey } from "../../actions";
import { CreateKeyForm } from "./create-key-form";
import { CopyBlock } from "@/components/copy-block";
import { timeAgo } from "@/lib/time";

export default async function AgentsPage() {
  const { team } = await requireHuman();
  const db = await getDb();
  const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.teamId, team.id)).orderBy(desc(schema.apiKeys.createdAt));
  const h = await headers();
  const origin = process.env.APP_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;

  const claudeMd = `## Wheelhouse (project board + knowledge map)
This project is tracked in Shipstack Wheelhouse via the \`wheelhouse\` MCP server. Project key: <KEY>.
- At the start of every task: call \`get_changes\` and handle what the team changed (moved/edited tickets, comments to you, stale map nodes), then \`ack_changes\`.
- Work from tickets. Move a ticket to "In Progress" when you start and to "Review" when done. Never move to "Done" yourself.
- Ask questions and report what you changed as \`comment\`s on the ticket — that's how the team talks to you.
- Create tickets for follow-up work you discover instead of silently expanding scope.
- The knowledge map (concept → system → code) is how the team understands this codebase without reading it. Read it (\`get_graph\`, \`get_node\`) before structural work.
- After finishing work: \`report_changes\` with the files you touched; re-describe nodes that went stale (or \`mark_fresh\`); add/adjust nodes, \`implements\` links and flows for anything new; record an ADR (\`upsert_decision\`) for non-obvious choices.`;

  const hook = `#!/bin/sh
# .git/hooks/post-commit — flags map nodes whose code changed (needs jq)
[ -z "$WHEELHOUSE_KEY" ] && exit 0
files=$(git diff-tree --no-commit-id --name-only -r HEAD | jq -R . | jq -sc .)
curl -s -X POST ${origin}/api/v1/report_changes \\
  -H "Authorization: Bearer $WHEELHOUSE_KEY" -H "Content-Type: application/json" \\
  -d "{\\"project\\":\\"<KEY>\\",\\"files\\":$files,\\"sha\\":\\"$(git rev-parse HEAD)\\"}" >/dev/null &`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
        <div>
          <h1 className="text-xl font-semibold">Agents &amp; API keys</h1>
          <p className="mt-1 text-sm text-muted">
            Give each agent (each dev&apos;s Claude Code, a CI bot…) its own key. Every key gets its own change queue, and everything it does is
            attributed to it on the board.
          </p>
        </div>

        <div className="card p-5">
          <h2 className="font-medium">1. Create a key</h2>
          <CreateKeyForm />
          {keys.length > 0 && (
            <ul className="mt-5 divide-y divide-line text-sm">
              {keys.map((k) => (
                <li key={k.id} className="flex items-center gap-3 py-2">
                  <span className={k.revokedAt ? "text-muted line-through" : "text-agent"}>🤖 {k.name}</span>
                  <code className="font-mono text-xs text-muted">{k.prefix}…</code>
                  <span className="ml-auto text-xs text-muted">
                    {k.revokedAt ? "revoked" : k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}
                  </span>
                  {!k.revokedAt && (
                    <form action={markAllSeenAction}>
                      <input type="hidden" name="keyId" value={k.id} />
                      <button className="btn btn-ghost py-1 text-xs" title="Reset this agent's queue in every project">Mark all seen</button>
                    </form>
                  )}
                  {!k.revokedAt && (
                    <form action={revokeApiKey}>
                      <input type="hidden" name="id" value={k.id} />
                      <button className="btn btn-danger py-1 text-xs">Revoke</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card space-y-3 p-5">
          <h2 className="font-medium">2. Connect Claude Code</h2>
          <p className="text-sm text-muted">Run in your repo (use the key from step 1):</p>
          <CopyBlock value={`claude mcp add --transport http wheelhouse ${origin}/mcp --header "Authorization: Bearer wh_YOUR_KEY"`} />
          <p className="text-sm text-muted">
            Add <code className="font-mono">--scope project</code> to share the server config via <code className="font-mono">.mcp.json</code> (keep
            keys out of git — use <code className="font-mono">{"${WHEELHOUSE_KEY}"}</code> env expansion).
          </p>
        </div>

        <div className="card space-y-3 p-5">
          <h2 className="font-medium">3. Tell the agent how to work</h2>
          <p className="text-sm text-muted">Paste into your repo&apos;s CLAUDE.md:</p>
          <CopyBlock value={claudeMd} multiline />
        </div>

        <div className="card space-y-3 p-5">
          <h2 className="font-medium">4. Build the knowledge map</h2>
          <p className="text-sm text-muted">
            The server ships prompts that show up as slash commands in Claude Code. Run once to map the repo into concepts, systems and code with
            flows, decisions and a glossary:
          </p>
          <CopyBlock value="/mcp__wheelhouse__map_codebase KEY" />
          <p className="text-sm text-muted">
            Later, <code className="font-mono">/mcp__wheelhouse__refresh_map KEY</code> re-describes nodes whose code changed, and{" "}
            <code className="font-mono">/mcp__wheelhouse__explain KEY &lt;topic&gt;</code> explains a part of the system and fills gaps in the map.
          </p>
        </div>

        <div className="card space-y-3 p-5">
          <h2 className="font-medium">5. Keep it fresh (optional)</h2>
          <p className="text-sm text-muted">
            A post-commit hook reports changed files so map nodes anchored to them are flagged <span className="text-warn">stale</span> on the
            map and show up in agents&apos; queues for re-describing:
          </p>
          <CopyBlock value={hook} multiline />
        </div>

        <div className="card space-y-3 p-5">
          <h2 className="font-medium">REST API</h2>
          <p className="text-sm text-muted">
            Same operations over HTTP for scripts and CI. List them at <code className="font-mono">GET {origin}/api/v1</code>.
          </p>
          <CopyBlock
            value={`curl -X POST ${origin}/api/v1/create_ticket \\
  -H "Authorization: Bearer wh_YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"project":"KEY","title":"Fix flaky login test","column":"Todo"}'`}
            multiline
          />
        </div>
      </div>
    </div>
  );
}
