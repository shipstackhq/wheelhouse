import { useActionState } from "react";
import { useParams } from "react-router";
import { Loaded } from "../components/query-state";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useProjectMembers } from "../lib/queries";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { useProjects } from "../lib/session";

/**
 * `/p/:key/settings`: the project's name and description (agents read the description). Any member reads them; only project
 * admins change them. The key is fixed once the project exists, because every ticket is named after it.
 */
export function ProjectSettingsPage() {
  const { key = "" } = useParams();
  const project = useProjects().data?.find((p) => p.key === key);
  const members = useProjectMembers(key);
  if (!project) return null;
  return (
    <Loaded query={members} label="Loading the settings">
      {({ myRole }) => <Settings projectKey={key} project={project} myRole={myRole} />}
    </Loaded>
  );
}

function Settings({ projectKey: key, project, myRole }: { projectKey: string; project: { name: string; description: string }; myRole: string | null }) {
  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 lg:py-12">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Project settings</h1>
        <p className="mb-6 text-sm text-muted">
          {myRole === "admin" ? "Rename the project or change what agents are told it is." : "Ask a project admin to change these."}
        </p>
        <div className="card p-5">
          {/* Keyed on what is saved, so the form starts again from the new values after a save. */}
          <SettingsForm key={`${project.name}\n${project.description}`} projectKey={key} name={project.name} description={project.description} canEdit={myRole === "admin"} />
        </div>
      </div>
    </div>
  );
}

function SettingsForm(props: { projectKey: string; name: string; description: string; canEdit: boolean }) {
  const { api, queryClient } = useServices();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      await api.projects.update(props.projectKey, { name: field(fd, "name"), description: field(fd, "description") });
      await refreshAll(queryClient); // the sidebar and the page header show the new name at once
      return { ok: "Saved." };
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_120px]">
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input className="input" id="name" name="name" required defaultValue={props.name} readOnly={!props.canEdit} />
      </div>
      <div>
        <label className="label" htmlFor="key">Key</label>
        <input className="input font-mono uppercase" id="key" value={props.projectKey} readOnly aria-describedby="key-help" />
      </div>
      <p id="key-help" className="-mt-1 text-xs text-muted sm:col-span-2">The key names every ticket ({props.projectKey}-1, {props.projectKey}-2…) and cannot be changed.</p>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="description">Description</label>
        <textarea
          className="input"
          id="description"
          name="description"
          rows={4}
          defaultValue={props.description}
          readOnly={!props.canEdit}
          placeholder="What is this project? Agents read this."
        />
      </div>
      {state?.error && <p className="text-sm text-danger sm:col-span-2" role="alert">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok sm:col-span-2" role="status">{state.ok}</p>}
      {props.canEdit && (
        <div className="sm:col-span-2">
          <SubmitButton className="btn btn-primary">Save changes</SubmitButton>
        </div>
      )}
    </form>
  );
}
