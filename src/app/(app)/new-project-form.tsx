"use client";

import { useActionState } from "react";
import { createProjectAction, type FormState } from "../actions";

export function NewProjectForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createProjectAction, undefined);
  return (
    <form action={action} className="mt-4 grid gap-3 sm:grid-cols-[1fr_120px]">
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input className="input" id="name" name="name" required placeholder="Wheelhouse" />
      </div>
      <div>
        <label className="label" htmlFor="key">Key</label>
        <input className="input font-mono uppercase" id="key" name="key" maxLength={6} placeholder="WH" />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="description">Description</label>
        <textarea className="input" id="description" name="description" rows={2} placeholder="What is this project? Agents read this." />
      </div>
      {state?.error && <p className="text-sm text-danger sm:col-span-2">{state.error}</p>}
      <div className="sm:col-span-2">
        <button className="btn btn-primary" disabled={pending}>Create project</button>
      </div>
    </form>
  );
}
