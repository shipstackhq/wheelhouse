import { useActionState, useState } from "react";
import { useParams } from "react-router";
import { Link, wsKey } from "../lib/workspace";
import { useQuery } from "@tanstack/react-query";
import { DangerZone } from "../components/team-danger-zone";
import { Loaded } from "../components/query-state";
import { TeamIconPicker } from "../components/team-icon-picker";
import { StatusesSection } from "./team-statuses";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useTeamMembers, useTeamSettings } from "../lib/queries";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { useTeams } from "../lib/session";
import { Page } from "../components/page";

/**
 * `/t/:key/settings`: the team's name and description (agents read the description). Any member reads them; only team
 * admins change them. The key is fixed once the team exists, because every issue is named after it.
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

function Settings({ teamKey: key, team, myRole }: { teamKey: string; team: { name: string; description: string; icon: string | null; iconColor: string | null }; myRole: string | null }) {
  return (
    <Page title="Team settings" hint={myRole === "admin" ? "Rename the team or change what agents are told it is." : "Ask a team admin to change these."}>
        <div className="card p-5">
          {/* Keyed on what is saved, so the form starts again from the new values after a save. */}
          <SettingsForm key={`${team.name}\n${team.description}`} teamKey={key} name={team.name} description={team.description} canEdit={myRole === "admin"} />
        </div>
        <div className="card mt-6 p-5">
          <h2 className="mb-1 font-medium">Icon</h2>
          <p className="mb-4 text-sm text-muted">Shown beside the team in the sidebar. Pick an icon and a colour, or an emoji.</p>
          <IconSection key={`${team.icon}\n${team.iconColor}`} teamKey={key} icon={team.icon} iconColor={team.iconColor} canEdit={myRole === "admin"} />
        </div>
        <div className="card mt-6 p-5">
          <h2 className="mb-1 font-medium">Statuses</h2>
          <p className="mb-4 text-sm text-muted">
            The stages an issue moves through. Each stage needs at least one status; when several share a stage, the default is where automatic moves
            (a merged pull request, an agent moving work to review) put an issue.
          </p>
          <StatusesSection teamKey={key} canEdit={myRole === "admin"} />
        </div>
        <div className="card mt-6 p-5">
          <h2 className="mb-1 font-medium">Parent team</h2>
          <p className="mb-4 text-sm text-muted">Places the team in a hierarchy. It changes nothing about who can open either team.</p>
          <ParentSection teamKey={key} canEdit={myRole === "admin"} />
        </div>
        <DangerZone teamKey={key} />
      </Page>
  );
}

function ParentSection({ teamKey, canEdit }: { teamKey: string; canEdit: boolean }) {
  const { api, queryClient } = useServices();
  const settings = useTeamSettings(teamKey).data;
  const options = useQuery({ queryKey: wsKey(api, "members", teamKey, "parent-candidates"), queryFn: () => api.teams.parentCandidates(teamKey), enabled: canEdit }).data;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!settings) return null;
  const change = async (parent: string) => {
    setPending(true);
    setError(null);
    try {
      await api.teams.setParent(teamKey, parent || null);
      await refreshAll(queryClient);
    } catch (e) {
      setError(failure(e)?.error ?? "Could not change the parent");
    } finally {
      setPending(false);
    }
  };
  return (
    <div>
      {canEdit ? (
        <>
          <label className="label" htmlFor="parent">Parent</label>
          <select className="input" id="parent" value={settings.parent?.key ?? ""} disabled={pending} onChange={(e) => change(e.target.value)}>
            <option value="">No parent (top level)</option>
            {settings.parent && !options?.some((o) => o.key === settings.parent!.key) && <option value={settings.parent.key}>{settings.parent.name}</option>}
            {options?.map((o) => (
              <option key={o.key} value={o.key}>{o.name}{o.retired ? " (retired)" : ""}</option>
            ))}
          </select>
        </>
      ) : (
        <p className="text-sm">{settings.parent ? settings.parent.name : "No parent team."}</p>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
      {(settings.children.length > 0 || settings.hiddenChildren > 0) && (
        <div className="mt-4">
          <h3 className="text-sm font-medium">Child teams</h3>
          <ul className="mt-1 text-sm text-muted">
            {settings.children.map((c) => (
              <li key={c.key}><Link className="hover:text-fg" to={`/t/${c.key}`}>{c.name}</Link>{c.retired ? " (retired)" : ""}</li>
            ))}
            {settings.hiddenChildren > 0 && <li>{settings.hiddenChildren} more you cannot open</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function IconSection(props: { teamKey: string; icon: string | null; iconColor: string | null; canEdit: boolean }) {
  const { api, queryClient } = useServices();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (icon: string | null, iconColor: string | null) => {
    setPending(true);
    setError(null);
    try {
      await api.teams.update(props.teamKey, { icon, iconColor });
      await refreshAll(queryClient); // the sidebar shows it at once
    } catch (e) {
      setError(failure(e)?.error ?? "Could not save the icon");
    } finally {
      setPending(false);
    }
  };
  return <TeamIconPicker teamKey={props.teamKey} icon={props.icon} iconColor={props.iconColor} canEdit={props.canEdit} pending={pending} error={error} onSave={save} />;
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
      <p id="key-help" className="-mt-1 text-xs text-muted sm:col-span-2">The key names every issue ({props.teamKey}-1, {props.teamKey}-2…) and cannot be changed.</p>
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
