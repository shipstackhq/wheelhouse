import { NewProjectForm } from "../../new-project-form";

export default function NewProjectPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="text-xl font-semibold">New project</h1>
        <p className="mt-1 text-sm text-muted">Each project has a kanban board, a knowledge map, and an AI change queue.</p>
        <div className="card mt-6 p-5">
          <NewProjectForm />
        </div>
      </div>
    </div>
  );
}
