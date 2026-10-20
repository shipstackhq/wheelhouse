import { Link } from "react-router";
import { ChangePasswordForm } from "../../components/change-password-form";
import { ChevronRightIcon } from "../../components/icons";
import { ThemeSwitch } from "../../components/theme-toggle";
import { useWorkspace } from "../../lib/queries";
import { canManagePeople } from "../../lib/roles";
import { useMe, useTeams } from "../../lib/session";

/** One settings section: a title, a line saying what it is, and its cards. */
function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="w-full space-y-4 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{hint}</p>
      </div>
      {children}
    </div>
  );
}

/** `/settings/profile`: who you are, and how the app looks for you. */
export function ProfileSettingsPage() {
  const me = useMe().data;
  if (!me) return null;
  return (
    <Section title="Profile" hint="Who you are in Wheelhouse, and how it looks for you.">
      <div className="card p-5">
        <h2 className="font-medium">Profile</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[120px_1fr]">
          <dt className="text-muted">Name</dt>
          <dd>{me.user.name}</dd>
          <dt className="text-muted">Email</dt>
          <dd>{me.user.email}</dd>
        </dl>
      </div>
      <div className="card p-5">
        <h2 className="font-medium">Appearance</h2>
        <div className="mt-3">
          <ThemeSwitch />
        </div>
      </div>
    </Section>
  );
}

/** `/settings/password`: change your own password. */
export function PasswordSettingsPage() {
  return (
    <Section title="Password" hint="Change the password you sign in with.">
      <div className="card p-5">
        <h2 className="font-medium">Your password</h2>
        <ChangePasswordForm />
      </div>
    </Section>
  );
}

/** `/settings/workspace`: the workspace, your place in it, and its seats (for those who manage people). */
export function WorkspaceSettingsPage() {
  const me = useMe().data;
  const workspace = useWorkspace().data;
  if (!me) return null;
  const manages = canManagePeople(me.role);
  return (
    <Section title="General" hint="This workspace, and your place in it.">
      <div className="card p-5">
        <h2 className="font-medium">{me.workspace.name}</h2>
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
        <p className="mt-3 text-xs text-muted">To switch workspace, go back to the app and use the round icon at the top of its sidebar.</p>
      </div>
    </Section>
  );
}

/** `/settings/teams`: your teams, each with the way to its own settings. */
export function TeamsSettingsPage() {
  const teams = useTeams().data ?? [];
  return (
    <Section title="Teams" hint="The teams you are on. A team's name, description and members are managed on the team itself.">
      <div className="card p-5">
        {teams.length === 0 ? (
          <p className="text-sm text-muted">You are not on a team yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
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
    </Section>
  );
}
