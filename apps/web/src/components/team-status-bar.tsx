import { useState } from "react";
import { Link } from "../lib/workspace";
import { failure } from "../lib/form-state";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { useTeamSettings } from "../lib/queries";

/**
 * Above a team's pages: where the team sits (its parent, as a breadcrumb) and, for a retired team, a banner saying it is read only
 * with a Restore button for its admins. Hierarchy shows here only; it never opens a team to anyone (ADR-23).
 */
export function TeamStatusBar({ teamKey }: { teamKey: string }) {
  const { api, queryClient } = useServices();
  const settings = useTeamSettings(teamKey).data;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!settings) return null;
  const restore = async () => {
    setPending(true);
    setError(null);
    try {
      await api.teams.restore(teamKey);
      await refreshAll(queryClient);
    } catch (e) {
      setError(failure(e)?.error ?? "Could not restore the team");
    } finally {
      setPending(false);
    }
  };
  if (!settings.parent && !settings.team.retired) return null;
  return (
    <div className="border-b border-line bg-panel px-4 py-2 text-sm">
      {settings.parent && (
        <nav aria-label="Parent team" className="text-xs text-muted">
          <Link className="hover:text-fg" to={`/t/${settings.parent.key}`}>{settings.parent.name}</Link>
          {settings.parent.retired && " (retired)"} / <span className="text-fg">{settings.team.name}</span>
        </nav>
      )}
      {settings.team.retired && (
        <div className="flex flex-wrap items-center gap-3" role="status">
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-xs font-medium">Retired</span>
          <span className="text-muted">This team is read only. Its issues, map and members are kept.</span>
          {settings.myRole === "admin" && (
            <button type="button" className="btn" disabled={pending} onClick={restore}>Restore</button>
          )}
          {error && <span className="text-danger" role="alert">{error}</span>}
        </div>
      )}
    </div>
  );
}
