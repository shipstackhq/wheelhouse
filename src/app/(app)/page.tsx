import Link from "next/link";
import { requireHuman } from "@/lib/auth";
import { listProjects } from "@/lib/service";
import { NewProjectForm } from "./new-project-form";

export default async function Home() {
  const { actor } = await requireHuman();
  const projects = await listProjects(actor);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-xl font-semibold">Projects</h1>
        <p className="mt-1 text-sm text-muted">Each project has a kanban board, an architecture map, and an AI change queue.</p>
        {projects.length > 0 && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {projects.map((p) => (
              <Link key={p.id} href={`/p/${p.key}`} className="card p-4 hover:border-muted/60">
                <div className="flex items-center gap-2">
                  <span className="chip bg-accent/15 font-mono text-accent">{p.key}</span>
                  <span className="font-medium">{p.name}</span>
                </div>
                {p.description && <p className="mt-2 line-clamp-2 text-sm text-muted">{p.description}</p>}
                <p className="mt-2 text-xs text-muted">{p.ticketCounter} tickets</p>
              </Link>
            ))}
          </div>
        )}
        <div className="card mt-8 p-5">
          <h2 className="font-medium">New project</h2>
          <NewProjectForm />
        </div>
      </div>
    </div>
  );
}
