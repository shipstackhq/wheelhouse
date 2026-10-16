import { useActionState, useState } from "react";
import { useNavigate } from "react-router";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useServices } from "../lib/services";

function deriveKey(name: string): string {
  const words = name.trim().toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (!words.length) return "";
  if (words.length === 1) return words[0].slice(0, 4);
  return words.map((w) => w[0]).join("").slice(0, 6);
}

export function NewProjectPage() {
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

export function NewProjectForm() {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      const project = await api.projects.create({ name: field(fd, "name"), key: field(fd, "key") || undefined, description: field(fd, "description") });
      await queryClient.invalidateQueries({ queryKey: ["projects"] }); // the sidebar's switcher lists it at once
      await navigate(`/p/${project.key}/onboarding`);
      return undefined;
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const shownKey = keyTouched ? key : deriveKey(name) || key;

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_120px]">
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input className="input" id="name" name="name" required autoFocus placeholder="Wheelhouse" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="key">Key</label>
        <input
          className="input font-mono uppercase"
          id="key"
          name="key"
          maxLength={6}
          placeholder="WH"
          value={shownKey}
          onChange={(e) => {
            setKeyTouched(true);
            setKey(e.target.value.toUpperCase());
          }}
        />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="description">Description</label>
        <textarea className="input" id="description" name="description" rows={2} placeholder="What is this project? Agents read this." />
      </div>
      {state?.error && <p className="text-sm text-danger sm:col-span-2" role="alert">{state.error}</p>}
      <div className="sm:col-span-2">
        <SubmitButton className="btn btn-primary">Create project</SubmitButton>
      </div>
    </form>
  );
}
