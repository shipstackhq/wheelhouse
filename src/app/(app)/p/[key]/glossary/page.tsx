import { requireHuman } from "@/lib/auth";
import { getGraph } from "@wheelhouse/core/lib/service";
import { Glossary } from "./glossary";

export default async function GlossaryPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { actor } = await requireHuman();
  const g = await getGraph(actor, key);
  return (
    <Glossary
      projectKey={g.project.key}
      terms={g.terms.map(({ id, term, definition, nodeId }) => ({ id, term, definition, nodeId }))}
      nodes={g.nodes.filter((n) => n.layer === "concept").map(({ id, name }) => ({ id, name }))}
    />
  );
}
