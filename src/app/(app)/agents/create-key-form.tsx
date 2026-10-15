"use client";

import { useActionState } from "react";
import { createApiKey, type FormState } from "../../actions";
import { SecretBox } from "@/components/secret-box";
import { SubmitButton } from "@/components/submit-button";

export function CreateKeyForm() {
  const [state, action] = useActionState<FormState, FormData>(createApiKey, undefined);
  return (
    <form action={action} className="mt-3 space-y-2">
      <div className="flex gap-2">
        <input className="input" name="name" placeholder={`e.g. "Claude — Priya's laptop"`} />
        <SubmitButton className="btn btn-primary shrink-0">Create key</SubmitButton>
      </div>
      {state?.ok && <p className="text-sm text-ok">{state.ok}</p>}
      {state?.secret && <SecretBox value={state.secret} />}
    </form>
  );
}
