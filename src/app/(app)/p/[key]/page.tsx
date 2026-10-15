import { requireHuman } from "@/lib/auth";
import { getBoard, getGraph, checklistForProject } from "@/lib/service";
import { getDb, schema } from "@/db";
import { eq } from "drizzle-orm";
import { Board } from "./board";
import { SetupChecklist } from "@/components/setup-checklist";

export default async function BoardPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { actor } = await requireHuman();
  const [board, graph, checklist] = await Promise.all([getBoard(actor, key), getGraph(actor, key), checklistForProject(actor, key)]);
  const db = await getDb();
  const members = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.teamId, actor.teamId));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-4">
        <SetupChecklist state={checklist} />
      </div>
      <div className="min-h-0 flex-1">
        <Board
          projectKey={board.project.key}
          columns={board.columns.map(({ id, name }) => ({ id, name }))}
          tickets={board.tickets}
          nodes={graph.nodes.map(({ id, name, kind, parentId, layer }) => ({ id, name, kind, parentId, layer }))}
          members={members}
        />
      </div>
    </div>
  );
}
