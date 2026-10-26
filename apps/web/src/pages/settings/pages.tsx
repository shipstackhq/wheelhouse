import { useState } from "react";
import { Link } from "../../lib/workspace";
import { ChangePasswordForm } from "../../components/change-password-form";
import { ChevronRightIcon } from "../../components/icons";
import { ImageUpload } from "../../components/image-upload";
import { Avatar } from "../../components/profile-menu";
import { useServices } from "../../lib/services";
import { ThemeSwitch } from "../../components/theme-toggle";
import { useAgents, useWorkspace } from "../../lib/queries";
import { SubmitButton } from "../../components/submit-button";
import { Select } from "../../components/ui";
import { failure, field } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
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
  const { api } = useServices();
  const me = useMe().data;
  if (!me) return null;
  return (
    <Section title="Profile" hint="Who you are in Wheelhouse, and how it looks for you.">
      <div className="card p-5">
        <h2 className="font-medium">Profile</h2>
        <div className="mt-3">
          <ImageUpload
            label="Profile picture"
            preview={<Avatar name={me.user.name} email={me.user.email} size={56} imageUrl={me.user.avatarUrl} />}
            hasImage={!!me.user.avatarUrl}
            onSave={(data) => api.avatar.set(data)}
            onRemove={() => api.avatar.remove()}
          />
        </div>
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
  const { api, queryClient } = useServices();
  const me = useMe().data;
  const workspace = useWorkspace().data;
  const agents = useAgents().data;
  if (!me) return null;
  const manages = canManagePeople(me.role);
  return (
    <Section title="General" hint="This workspace, and your place in it.">
      <div className="card p-5">
        <h2 className="font-medium">{me.workspace.name}</h2>
        {manages && (
          <div className="mt-3">
            <ImageUpload
              label="Workspace image"
              preview={
                me.workspace.imageUrl ? (
                  <img src={me.workspace.imageUrl} alt="" className="size-14 rounded-xl object-cover" />
                ) : (
                  <span aria-hidden className="grid size-14 place-items-center rounded-xl bg-accent/15 text-xl font-semibold uppercase text-accent">{me.workspace.name.trim().charAt(0) || "W"}</span>
                )
              }
              hasImage={!!me.workspace.imageUrl}
              onSave={(data) => api.workspace.setImage(data)}
              onRemove={() => api.workspace.removeImage()}
            />
          </div>
        )}
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
      <Transfer />
      {manages && agents && (
        <div className="card p-5">
          <h2 className="font-medium">Agents</h2>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={agents.enabled}
              onChange={(e) => void api.workspace.setAgentsEnabled(e.target.checked).catch(() => {}).then(() => refreshAll(queryClient))}
            />
            <span>
              Agents
              <span className="block text-xs text-muted">Wheelhouse&apos;s agents and your own, on the Agents page and each team&apos;s roster. Turning them off hides them and keeps everything.</span>
            </span>
          </label>
        </div>
      )}
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

/** Ownership transfer: the owner offers it to another member and can withdraw it; the person offered it accepts or declines. */
function Transfer() {
  const { api, queryClient } = useServices();
  const me = useMe().data;
  const w = useWorkspace().data;
  const [error, setError] = useState<string>();
  if (!me || !w) return null;
  const act = async (run: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(failure(e)?.error);
    }
    await refreshAll(queryClient);
  };
  const toYou = w.transfer?.userId === me.user.id;
  const candidates = w.members.filter((m) => m.userId !== me.user.id && m.role !== "guest");
  if (!toYou && w.role !== "owner") return null;
  return (
    <div className="card p-5">
      <h2 className="font-medium">Transfer ownership</h2>
      {toYou ? (
        <>
          <p className="mt-1 text-sm text-muted">You have been offered ownership of {w.workspace.name}. Accepting makes you its owner and the current owners admins.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn" onClick={() => act(api.workspace.acceptTransfer)}>Accept</button>
            <button type="button" className="btn" onClick={() => act(api.workspace.declineTransfer)}>Decline</button>
          </div>
        </>
      ) : w.transfer ? (
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted">Waiting for {w.transfer.name} to accept. You stay the owner until they do.</span>
          <button type="button" className="btn" onClick={() => act(api.workspace.cancelTransfer)}>Cancel</button>
        </div>
      ) : (
        <form action={(fd) => act(() => api.workspace.transferOwnership(field(fd, "userId")))} className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <Select name="userId" ariaLabel="New owner" defaultValue={candidates[0]?.userId} className="w-56" options={candidates.map((m) => ({ value: m.userId, label: m.name }))} />
          <SubmitButton className="btn" disabled={!candidates.length}>Transfer</SubmitButton>
          <span className="basis-full text-xs text-muted">They must accept. You become an admin when they do.</span>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}
