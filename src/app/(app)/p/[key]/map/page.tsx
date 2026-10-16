import { requireHuman } from "@/lib/auth";
import { getGraph } from "@wheelhouse/core/lib/service";
import { askEnabled } from "@wheelhouse/core/lib/ask";
import { KnowledgeMap } from "./knowledge-map";

export default async function MapPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ node?: string; flow?: string; lens?: string }>;
}) {
  const { key } = await params;
  const sp = await searchParams;
  const { actor } = await requireHuman();
  const g = await getGraph(actor, key);
  return (
    <KnowledgeMap
      projectKey={g.project.key}
      initial={JSON.parse(JSON.stringify(g))}
      askEnabled={askEnabled()}
      initialNode={sp.node}
      initialFlow={sp.flow}
      initialLens={sp.lens}
    />
  );
}
