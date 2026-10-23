import { useState } from "react";
import { timeAgo } from "@wheelhouse/shared/time";
import { List } from "./list";
import type { KeyRow } from "./active-keys";
import { AgentIcon } from "./icons";

/**
 * Revoked keys, kept out of the way: nothing but a button until it is pressed, and nothing at all when there are none.
 * They can't be used or reset, so the list has no actions.
 */
export function RevokedKeys({ keys, defaultOpen = false }: { keys: KeyRow[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!keys.length) return null;
  return (
    <div className="mt-4">
      <button type="button" className="btn btn-ghost py-1 text-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide revoked keys" : `Show revoked keys (${keys.length})`}
      </button>
      {open && (
        <List inset="card" className="mt-3 text-sm">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3">
              <span className="text-muted line-through"><AgentIcon /> {k.name}</span>
              <code className="font-mono text-xs text-muted">{k.prefix}…</code>
              <span className="ml-auto text-xs text-muted">{k.revokedAt ? `revoked ${timeAgo(k.revokedAt)}` : "revoked"}</span>
            </li>
          ))}
        </List>
      )}
    </div>
  );
}
