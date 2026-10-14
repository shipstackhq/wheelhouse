"use client";

import { useActionState } from "react";
import { changePassword, type FormState } from "../../actions";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(changePassword, undefined);
  return (
    <form action={action} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
      <input className="input" name="current" type="password" placeholder="Current password" required autoComplete="current-password" />
      <input className="input" name="next" type="password" placeholder="New password (12+)" required minLength={12} autoComplete="new-password" />
      <button className="btn" disabled={pending}>Update</button>
      {state?.error && <p className="text-sm text-danger sm:col-span-3">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok sm:col-span-3">{state.ok}</p>}
    </form>
  );
}
