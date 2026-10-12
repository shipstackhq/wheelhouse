import { requireHuman } from "@/lib/auth";
import { getGraph } from "@/lib/service";
import { Decisions } from "./decisions";

export default async function DecisionsPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { actor } = await requireHuman();
  const g = await getGraph(actor, key);
  return (
    <Decisions
      projectKey={g.project.key}
      decisions={JSON.parse(JSON.stringify(g.decisions))}
      nodes={g.nodes.map(({ id, name, layer }) => ({ id, name, layer }))}
      terms={g.terms.map(({ term, definition }) => ({ term, definition }))}
    />
  );
}
