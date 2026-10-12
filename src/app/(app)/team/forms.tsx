"use client";

import { useActionState } from "react";
import { addMember, changePassword, type FormState } from "../../actions";
import { SecretBox } from "@/components/secret-box";

export function AddMemberForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(addMember, undefined);
  return (
    <form action={action} className="mt-4 grid gap-3 sm:grid-cols-2">
      <input className="input" name="name" placeholder="Name" required />
      <input className="input" name="email" type="email" placeholder="Email" required />
      <select name="role" className="input" defaultValue="member">
        <option value="member">member</option>
        <option value="owner">owner</option>
      </select>
      <input className="input" name="tags" placeholder="tags: backend, design" />
      {state?.error && <p className="text-sm text-danger sm:col-span-2">{state.error}</p>}
      {state?.ok && (
        <div className="sm:col-span-2">
          <p className="text-sm text-ok">{state.ok}</p>
          {state.secret && <SecretBox value={state.secret} />}
        </div>
      )}
      <div className="sm:col-span-2">
        <button className="btn btn-primary" disabled={pending}>Add member</button>
      </div>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePassword, undefined);
  return (
    <form action={action} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
      <input className="input" name="current" type="password" placeholder="Current password" required autoComplete="current-password" />
      <input className="input" name="next" type="password" placeholder="New password (8+)" required minLength={8} autoComplete="new-password" />
      <button className="btn" disabled={pending}>Update</button>
      {state?.error && <p className="text-sm text-danger sm:col-span-3">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok sm:col-span-3">{state.ok}</p>}
    </form>
  );
}
