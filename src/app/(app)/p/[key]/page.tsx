import { requireHuman } from "@/lib/auth";
import { getBoard, getGraph } from "@/lib/service";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { Board } from "./board";

export default async function BoardPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { actor } = await requireHuman();
  const [board, graph] = await Promise.all([getBoard(actor, key), getGraph(actor, key)]);
  const db = await getDb();
  const members = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.teamId, actor.teamId));
  return (
    <Board
      projectKey={board.project.key}
      columns={board.columns.map(({ id, name }) => ({ id, name }))}
      tickets={board.tickets}
      nodes={graph.nodes.map(({ id, name, kind, parentId, layer }) => ({ id, name, kind, parentId, layer }))}
      members={members}
    />
  );
}
