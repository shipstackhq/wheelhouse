import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireHuman } from "@/lib/auth";
import { getProject, ServiceError } from "@wheelhouse/core/lib/service";
import { LiveRefresh } from "@/components/live-refresh";
import { BotsMenuFallback, ProjectQueueMenu } from "@/components/project-queue-menu";

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { actor } = await requireHuman();
  let project;
  try {
    project = await getProject(actor, key);
  } catch (e) {
    if (e instanceof ServiceError) notFound();
    throw e;
  }
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="chip bg-accent/15 font-mono text-accent">{project.key}</span>
            <h1 className="truncate font-semibold">{project.name}</h1>
          </div>
        </div>
        <div className="ml-auto">
          <Suspense fallback={<BotsMenuFallback />}>
            <ProjectQueueMenu projectKey={project.key} />
          </Suspense>
        </div>
      </header>
      <LiveRefresh projectKey={project.key} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
