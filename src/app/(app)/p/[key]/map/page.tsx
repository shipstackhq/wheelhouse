import { requireHuman } from "@/lib/auth";
import { getGraph } from "@/lib/service";
import { ArchitectureMap } from "./architecture-map";

export default async function MapPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { actor } = await requireHuman();
  const g = await getGraph(actor, key);
  return <ArchitectureMap projectKey={g.project.key} initial={JSON.parse(JSON.stringify(g))} />;
}
