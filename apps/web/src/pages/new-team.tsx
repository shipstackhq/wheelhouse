import { useActionState, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useServices } from "../lib/services";

function deriveKey(name: string): string {
  const words = name.trim().toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (!words.length) return "";
  if (words.length === 1) return words[0].slice(0, 4);
  return words.map((w) => w[0]).join("").slice(0, 6);
}

export function NewTeamPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full px-6 py-10">
        <h1 className="text-xl font-semibold">New team</h1>
        <p className="mt-1 text-sm text-muted">Each team has a kanban board, a knowledge map, and an AI change queue.</p>
        <div className="card mt-6 p-5">
          <NewTeamForm />
        </div>
      </div>
    </div>
  );
}

export function NewTeamForm() {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      const team = await api.teams.create({ name: field(fd, "name"), key: field(fd, "key") || undefined, description: field(fd, "description"), parent: field(fd, "parent") || null });
      await queryClient.invalidateQueries({ queryKey: ["teams"] }); // the sidebar's switcher lists it at once
      await navigate(`/t/${team.key}/onboarding`);
      return undefined;
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  const parents = useQuery({ queryKey: ["teams", "parent-candidates"], queryFn: () => api.teams.parentCandidates() }).data;
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
        <label className="label" htmlFor="parent">Parent team (optional)</label>
        <select className="input" id="parent" name="parent" defaultValue="">
          <option value="">No parent (top level)</option>
          {parents?.map((p) => (
            <option key={p.key} value={p.key}>{p.name}{p.retired ? " (retired)" : ""}</option>
          ))}
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="description">Description</label>
        <textarea className="input" id="description" name="description" rows={2} placeholder="What is this team? Agents read this." />
      </div>
      {state?.error && <p className="text-sm text-danger sm:col-span-2" role="alert">{state.error}</p>}
      <div className="sm:col-span-2">
        <SubmitButton className="btn btn-primary">Create team</SubmitButton>
      </div>
    </form>
  );
}
