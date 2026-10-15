import { requireHuman } from "@/lib/auth";
import { getGraph, listDocs } from "@/lib/service";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { DocsExplorer } from "./docs-explorer";

export default async function DocsPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { actor } = await requireHuman();
  const [g, docs] = await Promise.all([getGraph(actor, key), listDocs(actor, key)]);
  const db = await getDb();
  const members = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.teamId, actor.teamId));
  return (
    <DocsExplorer
      projectKey={g.project.key}
      initialTree={docs}
      nodes={g.nodes.map(({ id, name, layer, parentId }) => ({ id, name, layer, parentId }))}
      decisions={g.decisions.map(({ id, number, title }) => ({ id, number, title }))}
      members={members}
    />
  );
}
