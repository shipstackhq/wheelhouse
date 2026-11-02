import { DropdownMenu } from "radix-ui";
import clsx from "clsx";
import { timeAgo } from "@wheelhouse/shared/time";
import { AgentIcon, MoreIcon } from "./icons";
import { scopeSummary } from "./key-dialog";
import { SETTINGS_ROW_PAD, SettingsList } from "./settings-list";
import { useDialogs } from "./ui";

/** What the keys lists need. Dates are ISO strings so the revoked list can cross into a client component. */
export type KeyRow = { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; scopes?: string[]; teams?: { key: string; name: string }[] };
/** A team a key could be given: one the person edits. */
export type TeamOption = { key: string; name: string };

/** Live keys keep the order they came in; revoked ones go most recently revoked first. */
export function splitKeys(keys: KeyRow[]) {
  const active = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt).sort((a, b) => b.revokedAt!.localeCompare(a.revokedAt!));
  return { active, revoked };
}

const item = "flex cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-fg/[0.07]";

/**
 * The keys that work today: name, prefix, teams, what each can do, when last used, and a menu (Edit, Mark all seen, Revoke).
 * The actions are passed in so the component stays presentational (and renderable in tests without a server).
 */
export function ActiveKeys({ keys, onEdit, markAllSeen, revoke }: { keys: KeyRow[]; onEdit: (k: KeyRow) => void; markAllSeen: (id: string) => void | Promise<void>; revoke: (id: string) => void | Promise<void> }) {
  const { confirm, dialogs } = useDialogs();
  return (
    <>
      <SettingsList title="Active keys">
        {!keys.length ? (
          <p className={`text-sm text-muted ${SETTINGS_ROW_PAD}`}>No active keys. Make one with New key.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {keys.map((k) => (
              <li key={k.id} className={`flex items-center gap-3 ${SETTINGS_ROW_PAD}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-agent"><AgentIcon /> {k.name}</span>
                    <code className="font-mono text-xs text-muted">{k.prefix}…</code>
                    {k.teams?.length === 0 ? (
                      <span className="text-xs text-warn">no teams: reaches nothing</span>
                    ) : (
                      k.teams?.map((t) => <span key={t.key} className="chip bg-panel-2 text-xs text-muted" title={t.name}>{t.key}</span>)
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{scopeSummary(k.scopes)} · {k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</div>
                </div>
                <DropdownMenu.Root modal={false}>
                  <DropdownMenu.Trigger aria-label={`Actions for ${k.name}`} className="btn btn-ghost px-1.5 py-1">
                    <MoreIcon />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={4} className="z-60 min-w-40 rounded-lg border border-line bg-panel p-1 shadow-lg">
                      <DropdownMenu.Item className={item} onSelect={() => onEdit(k)}>Edit</DropdownMenu.Item>
                      <DropdownMenu.Item className={item} onSelect={() => void markAllSeen(k.id)}>Mark all seen</DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={clsx(item, "text-danger")}
                        onSelect={async () => {
                          if (await confirm({ title: `Revoke ${k.name}?`, description: "The agent stops working at once. This can't be undone.", confirmLabel: "Revoke", danger: true })) await revoke(k.id);
                        }}
                      >
                        Revoke
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </li>
            ))}
          </ul>
        )}
      </SettingsList>
      {dialogs}
    </>
  );
}
