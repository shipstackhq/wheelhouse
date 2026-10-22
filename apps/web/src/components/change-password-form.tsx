import { useActionState } from "react";
import { failure, field, type FormState } from "../lib/form-state";
import { useServices } from "../lib/services";
import { SubmitButton } from "./submit-button";

/** Change your own password: the current one must be right, the new one at least twelve characters. */
export function ChangePasswordForm() {
  const { api } = useServices();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      await api.changePassword({ current: field(fd, "current"), next: field(fd, "next") });
      return { ok: "Password updated" };
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
      <input className="input" name="current" type="password" placeholder="Current password" aria-label="Current password" required autoComplete="current-password" />
      <input className="input" name="next" type="password" placeholder="New password (12+)" aria-label="New password" required minLength={12} autoComplete="new-password" />
      <SubmitButton className="btn">Update</SubmitButton>
      {state?.error && <p className="text-sm text-danger sm:col-span-3" role="alert">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok sm:col-span-3" role="status">{state.ok}</p>}
    </form>
  );
}
