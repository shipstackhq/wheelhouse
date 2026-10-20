import { useActionState } from "react";
import { useParams } from "react-router";
import { Loaded } from "../components/query-state";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useTeamMembers } from "../lib/queries";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { useTeams } from "../lib/session";

/**
 * `/t/:key/settings`: the team's name and description (agents read the description). Any member reads them; only team
 * admins change them. The key is fixed once the team exists, because every ticket is named after it.
 */
export function TeamSettingsPage() {
  const { key = "" } = useParams();
  const team = useTeams().data?.find((p) => p.key === key);
  const members = useTeamMembers(key);
  if (!team) return null;
  return (
    <Loaded query={members} label="Loading the settings">
      {({ myRole }) => <Settings teamKey={key} team={team} myRole={myRole} />}
    </Loaded>
  );
}

function Settings({ teamKey: key, team, myRole }: { teamKey: string; team: { name: string; description: string }; myRole: string | null }) {
  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="w-full px-4 py-8 sm:px-8 lg:py-12">
        <h1 className="mb-2 text-3xl font-bold tracking-tight">Team settings</h1>
        <p className="mb-6 text-sm text-muted">
          {myRole === "admin" ? "Rename the team or change what agents are told it is." : "Ask a team admin to change these."}
        </p>
        <div className="card p-5">
          {/* Keyed on what is saved, so the form starts again from the new values after a save. */}
          <SettingsForm key={`${team.name}\n${team.description}`} teamKey={key} name={team.name} description={team.description} canEdit={myRole === "admin"} />
        </div>
      </div>
    </div>
  );
}

function SettingsForm(props: { teamKey: string; name: string; description: string; canEdit: boolean }) {
  const { api, queryClient } = useServices();
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      await api.teams.update(props.teamKey, { name: field(fd, "name"), description: field(fd, "description") });
      await refreshAll(queryClient); // the sidebar and the page header show the new name at once
      return { ok: "Saved." };
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_120px]">
      <div>
        <label className="label" htmlFor="name">Name</label>
        <input className="input" id="name" name="name" required defaultValue={props.name} readOnly={!props.canEdit} />
      </div>
      <div>
        <label className="label" htmlFor="key">Key</label>
        <input className="input font-mono uppercase" id="key" value={props.teamKey} readOnly aria-describedby="key-help" />
      </div>
      <p id="key-help" className="-mt-1 text-xs text-muted sm:col-span-2">The key names every ticket ({props.teamKey}-1, {props.teamKey}-2…) and cannot be changed.</p>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="description">Description</label>
        <textarea
          className="input"
          id="description"
          name="description"
          rows={4}
          defaultValue={props.description}
          readOnly={!props.canEdit}
          placeholder="What is this team? Agents read this."
        />
      </div>
      {state?.error && <p className="text-sm text-danger sm:col-span-2" role="alert">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok sm:col-span-2" role="status">{state.ok}</p>}
      {props.canEdit && (
        <div className="sm:col-span-2">
          <SubmitButton className="btn btn-primary">Save changes</SubmitButton>
        </div>
      )}
    </form>
  );
}
