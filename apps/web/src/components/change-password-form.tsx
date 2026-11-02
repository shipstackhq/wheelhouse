import { useActionState } from "react";
import { failure, field, type FormState } from "../lib/form-state";
import { useServices } from "../lib/services";
import { SETTINGS_ROW_PAD, SettingsList, SettingsRow } from "./settings-list";
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
    <form action={action}>
      <SettingsList title="Your password">
        <SettingsRow label="Current password">
          <input className="input w-64" name="current" type="password" aria-label="Current password" required autoComplete="current-password" />
        </SettingsRow>
        <SettingsRow label="New password" hint="At least 12 characters">
          <input className="input w-64" name="next" type="password" aria-label="New password" required minLength={12} autoComplete="new-password" />
        </SettingsRow>
        <div className={`flex items-center justify-between gap-4 ${SETTINGS_ROW_PAD}`}>
          <div className="min-w-0 text-sm">
            {state?.error && <p className="text-danger" role="alert">{state.error}</p>}
            {state?.ok && <p className="text-ok" role="status">{state.ok}</p>}
          </div>
          <SubmitButton className="btn">Update</SubmitButton>
        </div>
      </SettingsList>
    </form>
  );
}
