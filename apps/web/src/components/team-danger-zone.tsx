import { useState } from "react";
import { useNavigate } from "../lib/workspace";
import type { TeamGuard } from "@wheelhouse/api-client";
import { failure } from "../lib/form-state";
import { useTeamSettings } from "../lib/queries";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { useMe } from "../lib/session";
import { SETTINGS_ROW_PAD, SettingsList, SettingsRow } from "./settings-list";

/**
 * Team settings → Danger zone: leave, retire and delete, each with a one-line description. A blocked action is disabled with the
 * reason beside it; the reasons come from the same guards the API runs, so what is shown is what a click would answer.
 */
export function DangerZone({ teamKey }: { teamKey: string }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const me = useMe().data;
  const settings = useTeamSettings(teamKey).data;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  if (!settings || !me) return null;

  const run = async (go: () => Promise<unknown>, after?: () => void) => {
    setPending(true);
    setError(null);
    try {
      await go();
      await refreshAll(queryClient);
      after?.();
    } catch (e) {
      setError(failure(e)?.error ?? "That did not work");
    } finally {
      setPending(false);
    }
  };

  const row = (title: string, what: string, g: TeamGuard, button: React.ReactNode) => (
    <SettingsRow label={title} hint={<>{what}{!g.allowed && g.reason && <span className="mt-1 block text-danger">{g.reason}</span>}</>}>
      {button}
    </SettingsRow>
  );

  const retired = settings.team.retired;
  return (
    <SettingsList title="Danger zone" danger>
      {row(
        "Leave team",
        "You lose access to this team until an admin adds you again.",
        settings.canLeave,
        <button
          type="button"
          className="btn"
          disabled={!settings.canLeave.allowed || pending}
          onClick={() => window.confirm(`Leave ${settings.team.name}?`) && run(() => api.teams.removeMember(teamKey, me.user.id), () => navigate("/"))}
        >
          Leave team
        </button>,
      )}
      {row(
        retired ? "Restore team" : "Retire team",
        retired ? "Make the team active again, with everything intact." : "Make the team read only and move it out of the main sidebar. You can restore it later.",
        retired ? { allowed: settings.myRole === "admin", reason: "Only a team admin can restore a team" } : settings.canRetire,
        <button
          type="button"
          className="btn"
          disabled={pending || (retired ? settings.myRole !== "admin" : !settings.canRetire.allowed)}
          onClick={() => (retired ? run(() => api.teams.restore(teamKey)) : window.confirm(`Retire ${settings.team.name}? It becomes read only.`) && run(() => api.teams.retire(teamKey)))}
        >
          {retired ? "Restore team" : "Retire team"}
        </button>,
      )}
      {row(
        "Delete team",
        "Delete the team and everything in it for good. This cannot be undone.",
        settings.canDelete,
        <button type="button" className="btn btn-danger" disabled={!settings.canDelete.allowed || pending} onClick={() => setDeleting((d) => !d)}>
          Delete team
        </button>,
      )}
      {deleting && settings.canDelete.allowed && (
        <form
          className={`flex flex-wrap items-end gap-3 ${SETTINGS_ROW_PAD}`}
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.teams.remove(teamKey, typed), () => navigate("/"));
          }}
        >
          <div>
            <label className="label" htmlFor="confirm-key">Type {teamKey} to confirm</label>
            <input className="input font-mono uppercase" id="confirm-key" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </div>
          <button type="submit" className="btn btn-danger" disabled={pending || typed.trim().toUpperCase() !== teamKey.toUpperCase()}>
            Delete {teamKey} for good
          </button>
        </form>
      )}
      {error && <p className={`text-sm text-danger ${SETTINGS_ROW_PAD}`} role="alert">{error}</p>}
    </SettingsList>
  );
}
