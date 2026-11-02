import { useActionState, useState, type ReactNode } from "react";
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
import { SETTINGS_ROW_PAD, SettingsList, SettingsRow } from "../components/settings-list";

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
  const canEdit = myRole === "admin";
  return (
    <Page title="Team settings" hint={canEdit ? "Rename the team or change what agents are told it is." : "Ask a team admin to change these."} className="space-y-6">
      {/* Keyed on what is saved, so the form starts again from the new values after a save. */}
      <SettingsForm key={`${team.name}\n${team.description}`} teamKey={key} name={team.name} description={team.description} canEdit={canEdit}>
        <IconSection key={`${team.icon}\n${team.iconColor}`} teamKey={key} icon={team.icon} iconColor={team.iconColor} canEdit={canEdit} />
      </SettingsForm>
      <SettingsList
        title="Statuses"
        hint="The stages an issue moves through. Each stage needs at least one status; when several share a stage, the default is where automatic moves (a merged pull request, an agent moving work to review) put an issue."
      >
        <div className={SETTINGS_ROW_PAD}>
          <StatusesSection teamKey={key} canEdit={canEdit} />
        </div>
      </SettingsList>
      <ParentSection teamKey={key} canEdit={canEdit} />
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
    <SettingsList title="Parent team" hint="Places the team in a hierarchy. It changes nothing about who can open either team.">
      <SettingsRow label="Parent">
        {canEdit ? (
          <select className="input w-64" aria-label="Parent" value={settings.parent?.key ?? ""} disabled={pending} onChange={(e) => change(e.target.value)}>
            <option value="">No parent (top level)</option>
            {settings.parent && !options?.some((o) => o.key === settings.parent!.key) && <option value={settings.parent.key}>{settings.parent.name}</option>}
            {options?.map((o) => (
              <option key={o.key} value={o.key}>{o.name}{o.retired ? " (retired)" : ""}</option>
            ))}
          </select>
        ) : (
          <span className="text-fg">{settings.parent ? settings.parent.name : "No parent team."}</span>
        )}
      </SettingsRow>
      {(settings.children.length > 0 || settings.hiddenChildren > 0) && (
        <SettingsRow label="Child teams">
          <ul className="text-right">
            {settings.children.map((c) => (
              <li key={c.key}><Link className="hover:text-fg hover:underline" to={`/t/${c.key}`}>{c.name}</Link>{c.retired ? " (retired)" : ""}</li>
            ))}
            {settings.hiddenChildren > 0 && <li>{settings.hiddenChildren} more you cannot open</li>}
          </ul>
        </SettingsRow>
      )}
      {error && <p className={`text-sm text-danger ${SETTINGS_ROW_PAD}`} role="alert">{error}</p>}
    </SettingsList>
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

function SettingsForm(props: { teamKey: string; name: string; description: string; canEdit: boolean; children: ReactNode }) {
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
    <form action={action}>
      <SettingsList title="General">
        <SettingsRow label="Name">
          <input className="input w-72" name="name" aria-label="Name" required defaultValue={props.name} readOnly={!props.canEdit} />
        </SettingsRow>
        <SettingsRow label="Key" hint={`Names every issue (${props.teamKey}-1, ${props.teamKey}-2…); it cannot be changed.`}>
          <span className="font-mono uppercase text-fg">{props.teamKey}</span>
        </SettingsRow>
        <SettingsRow label="Description" hint="What is this team? Agents read this.">
          <textarea className="input w-72" name="description" aria-label="Description" rows={3} defaultValue={props.description} readOnly={!props.canEdit} />
        </SettingsRow>
        <SettingsRow label="Icon" hint="Shown beside the team in the sidebar.">{props.children}</SettingsRow>
        {props.canEdit && (
          <div className={`flex items-center justify-between gap-4 ${SETTINGS_ROW_PAD}`}>
            <div className="min-w-0 text-sm">
              {state?.error && <p className="text-danger" role="alert">{state.error}</p>}
              {state?.ok && <p className="text-ok" role="status">{state.ok}</p>}
            </div>
            <SubmitButton className="btn btn-primary">Save changes</SubmitButton>
          </div>
        )}
      </SettingsList>
    </form>
  );
}
