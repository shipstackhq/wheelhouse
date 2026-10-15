import { timeAgo } from "@/lib/time";
import { List } from "./list";
import { SubmitButton } from "./submit-button";

/** What the keys lists need. Dates are ISO strings so the revoked list can cross into a client component. */
export type KeyRow = { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; canWriteDocs?: boolean };

/** Live keys keep the order they came in; revoked ones go most recently revoked first. */
export function splitKeys(keys: KeyRow[]) {
  const active = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt).sort((a, b) => b.revokedAt!.localeCompare(a.revokedAt!));
  return { active, revoked };
}

/**
 * The keys that work today: name, prefix, when last used, and the two things you can do to one. The actions are passed in
 * so the component stays presentational (and renderable in tests without a server).
 */
export function ActiveKeys({
  keys,
  markAllSeen,
  revoke,
  setDocsWrite,
}: {
  keys: KeyRow[];
  markAllSeen: (formData: FormData) => void | Promise<void>;
  revoke: (formData: FormData) => void | Promise<void>;
  /** WH-51: grant/revoke the "docs:write" capability. Keys default to read-only for docs. */
  setDocsWrite?: (keyId: string, canWrite: boolean) => void | Promise<void>;
}) {
  if (!keys.length) return <p className="mt-5 text-sm text-muted">No active keys. Create one above.</p>;
  return (
    <List inset="card" className="mt-5 text-sm">
      {keys.map((k) => (
        <li key={k.id} className="flex items-center gap-3">
          <span className="text-agent">🤖 {k.name}</span>
          <code className="font-mono text-xs text-muted">{k.prefix}…</code>
          {setDocsWrite && (
            <label className="ml-3 flex items-center gap-1.5 text-xs text-muted" title='Lets this key create/edit/delete docs via upsert_doc and delete_doc. Off by default (read-only).'>
              <input type="checkbox" checked={!!k.canWriteDocs} onChange={(e) => void setDocsWrite(k.id, e.target.checked)} />
              docs:write
            </label>
          )}
          <span className="ml-auto text-xs text-muted">{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</span>
          <form action={markAllSeen}>
            <input type="hidden" name="keyId" value={k.id} />
            <SubmitButton className="btn btn-ghost py-1 text-xs" title="Reset this agent's queue in every project">Mark all seen</SubmitButton>
          </form>
          <form action={revoke}>
            <input type="hidden" name="id" value={k.id} />
            <SubmitButton className="btn btn-danger py-1 text-xs">Revoke</SubmitButton>
          </form>
        </li>
      ))}
    </List>
  );
}
