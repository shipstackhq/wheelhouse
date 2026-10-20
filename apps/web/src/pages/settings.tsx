import { Link } from "react-router";
import { ChangePasswordForm } from "../components/change-password-form";
import { ChevronRightIcon } from "../components/icons";
import { ThemeSwitch } from "../components/theme-toggle";
import { useWorkspace } from "../lib/queries";
import { canManagePeople } from "../lib/roles";
import { useMe, useTeams } from "../lib/session";

/**
 * `/settings`: yours first (who you are, how the app looks, your password), then the workspace's (its name, your role, seats, and the
 * places where people, agent keys and each team are managed). Those places keep their own pages; this is the one door to them.
 */
export function SettingsPage() {
  const me = useMe().data;
  const teams = useTeams().data ?? [];
  const workspace = useWorkspace().data;
  if (!me) return null;
  const manages = canManagePeople(me.role);
  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full space-y-10 px-6 py-10">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-muted">Your own settings, and the workspace&apos;s.</p>
        </div>

        <section aria-labelledby="settings-personal" className="space-y-4">
          <h2 id="settings-personal" className="text-sm font-medium text-muted">Personal</h2>
          <div className="card p-5">
            <h3 className="font-medium">Profile</h3>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[120px_1fr]">
              <dt className="text-muted">Name</dt>
              <dd>{me.user.name}</dd>
              <dt className="text-muted">Email</dt>
              <dd>{me.user.email}</dd>
            </dl>
          </div>
          <div className="card p-5">
            <h3 className="font-medium">Appearance</h3>
            <div className="mt-3">
              <ThemeSwitch />
            </div>
          </div>
          <div className="card p-5">
            <h3 className="font-medium">Your password</h3>
            <ChangePasswordForm />
          </div>
        </section>

        <section aria-labelledby="settings-workspace" className="space-y-4">
          <h2 id="settings-workspace" className="text-sm font-medium text-muted">Workspace</h2>
          <div className="card p-5">
            <h3 className="font-medium">{me.workspace.name}</h3>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[120px_1fr]">
              <dt className="text-muted">Your role</dt>
              <dd className="flex flex-wrap items-center gap-1">
                <span className="chip bg-panel-2 text-fg">{me.role}</span>
                {me.tags.map((t) => (
                  <span key={t} className="chip bg-bg text-muted">{t}</span>
                ))}
              </dd>
              {workspace && manages && (
                <>
                  <dt className="text-muted">Seats</dt>
                  <dd>
                    {workspace.seats.used} of {workspace.seats.max} used ({workspace.seats.members} members, {workspace.seats.pending} pending)
                  </dd>
                </>
              )}
            </dl>
            <p className="mt-3 text-xs text-muted">To switch workspace, use the round icon at the top of the sidebar.</p>
          </div>
          <div className="card divide-y divide-line">
            <SettingsLink to="/workspace" title="Members" hint={workspace ? `${workspace.members.length} ${workspace.members.length === 1 ? "person" : "people"}${manages ? ", roles and invites" : ""}` : "People, roles and invites"} />
            <SettingsLink to="/agents" title="Agents & API keys" hint="Keys for your agents, and the teams each can open" />
          </div>
          <div className="card p-5">
            <h3 className="font-medium">Teams</h3>
            {teams.length === 0 ? (
              <p className="mt-2 text-sm text-muted">You are not on a team yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line text-sm">
                {teams.map((t) => (
                  <li key={t.key}>
                    <Link to={`/t/${t.key}/settings`} className="flex items-center gap-3 py-2 hover:text-fg" aria-label={`Settings of ${t.name}`}>
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      <span className="font-mono text-xs text-muted">{t.key}</span>
                      {t.role && <span className="chip bg-panel-2 text-muted">{t.role}</span>}
                      <ChevronRightIcon aria-hidden className="text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function SettingsLink({ to, title, hint }: { to: string; title: string; hint: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-panel-2">
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      <ChevronRightIcon aria-hidden className="text-muted" />
    </Link>
  );
}
