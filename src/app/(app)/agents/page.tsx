import { headers } from "next/headers";
import { desc, eq } from "drizzle-orm";
import { requireHuman } from "@/lib/auth";
import { getDb, schema } from "@wheelhouse/core/db";
import { markAllSeenAction, revokeApiKey, setKeyDocsWriteAction } from "../../actions";
import { CreateKeyForm } from "./create-key-form";
import { CopyBlock } from "@/components/copy-block";
import { ActiveKeysWithCapabilities } from "./active-keys-with-capabilities";
import { splitKeys, type KeyRow } from "@/components/active-keys";
import { RevokedKeys } from "@/components/revoked-keys";
import { onboarding } from "@wheelhouse/core/lib/onboarding";
import { SetupGuide } from "@/components/setup-guide";

export default async function AgentsPage() {
  const { team } = await requireHuman();
  const db = await getDb();
  const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.teamId, team.id)).orderBy(desc(schema.apiKeys.createdAt));
  const rows: KeyRow[] = keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    canWriteDocs: k.capabilities.includes("docs:write"),
  }));
  const { active, revoked } = splitKeys(rows);
  const h = await headers();
  const origin = process.env.APP_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;

  const teamProjects = await db.select({ key: schema.projects.key }).from(schema.projects).where(eq(schema.projects.teamId, team.id));
  // One project: put its real key in the commands. Several: leave a KEY placeholder rather than pick one.
  const cmd = onboarding({ origin, projectKey: teamProjects.length === 1 ? teamProjects[0].key : null });

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
          <p className="text-sm text-muted">The key is shown once, right after you create it. Copy it then; if you lose it, revoke it and create another.</p>
          <CreateKeyForm />
          <ActiveKeysWithCapabilities keys={active} markAllSeen={markAllSeenAction} revoke={revokeApiKey} setDocsWrite={setKeyDocsWriteAction} />
          <RevokedKeys keys={revoked} />
        </div>

        <SetupGuide cmd={cmd} />

        <div className="card space-y-3 p-5">
          <h2 className="font-medium">Other agents and CI</h2>
          <p className="text-sm text-muted">
            Any MCP client can connect to <code className="font-mono">{cmd.url}/mcp</code> with an <code className="font-mono">Authorization: Bearer</code>{" "}
            header (the Claude Code command is in setup B). The same operations are available over HTTP for scripts and CI (list them at{" "}
            <code className="font-mono">GET {cmd.url}/api/v1</code>). In CI, keep the key in the provider&apos;s secret store and expose it as{" "}
            <code className="font-mono">WHEELHOUSE_KEY</code>.
          </p>
          <CopyBlock value={cmd.rest} multiline />
        </div>
      </div>
    </div>
  );
}
