import { importData, integrity, openConn, snapshot, tablesInOrder, type Conn } from "./db-copy";

/**
 * Copying whole workspaces from an export into a database that already holds other workspaces (local → staging). The export is
 * loaded into a throwaway database, cut down to the named workspaces, and inserted into the target as it is: same ids, numbers and
 * timestamps. A member whose email the target already has becomes that user; other members are created; rows by people who are
 * no longer members are credited to the `as` user, who must already exist on the target.
 *
 * Left behind, because they belong to the machine they were made on or are only history: credentials, devices and runs, chat,
 * GitHub links, invites, event logs and notifications. All or nothing: the target is checked before it commits.
 */
const LEAVE = new Set([
  "sessions", "api_keys", "api_key_teams", "agent_cursors", "github_installations", "github_deliveries", "invites", "invite_teams",
  "devices", "device_messages", "device_pairings", "device_tokens", "device_jobs", "device_job_events", "run_defaults",
  "chat_threads", "chat_messages", "work_sessions", "node_drafts", "events", "audit_events", "workspace_events",
  "notifications", "broadcasts", "instance_keys",
]);

const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;

export type MergeResult = { tables: { name: string; rows: number }[]; matchedUsers: string[] };

export async function mergeWorkspaces(target: Conn, dir: string, slugs: string[], as: string): Promise<MergeResult> {
  const scratch = await openConn("memory://", { migrate: true });
  try {
    await importData(scratch, dir);
    const q = scratch.query;
    // The throwaway copy is cut down, so the guards that keep logs append-only go first (only user triggers; keys stay).
    for (const r of await q(`select tgname, tgrelid::regclass::text as rel from pg_trigger where not tgisinternal`)) await q(`drop trigger ${qi(String(r.tgname))} on ${r.rel}`);
    // The two places kept rows point at left-behind ones; both may be empty.
    await q(`update issues set claimed_by_key_id = null`);
    await q(`update doc_drafts set session_id = null`);
    const order = await tablesInOrder(q);
    for (const t of [...order].reverse()) if (LEAVE.has(t.name)) await q(`delete from ${qi(t.name)}`);
    const missing = (await q(`select s from unnest($1::text[]) s where s not in (select slug from workspaces)`, [slugs])).map((r) => String(r.s));
    if (missing.length) throw new Error(`the export has no workspace ${missing.join(", ")}`);
    await q(`delete from workspaces where slug <> all($1::text[])`, [slugs]);

    const [src, dst] = [await snapshot(q), await snapshot(target.query)];
    if (JSON.stringify(src.migrations) !== JSON.stringify(dst.migrations)) throw new Error(`the target's migrations (${dst.migrations.length}) are not this code's (${src.migrations.length})`);
    const taken = (await target.query(`select slug from workspaces where slug = any($1::text[])`, [slugs])).map((r) => String(r.slug));
    if (taken.length) throw new Error(`the target already has workspace ${taken.join(", ")}`);

    // Same email, same person: their rows point at the target's user, wherever the id appears (keys, actor columns, JSON).
    // Someone who is no longer a member is not copied; what they wrote is credited to `as`.
    const users = await q(`select id::text, lower(email) as email, exists (select 1 from memberships m where m.user_id = u.id) as member from users u`);
    const theirs = new Map((await target.query(`select id::text, lower(email) as email from users where lower(email) = any($1::text[])`, [[...users.map((u) => u.email), as.toLowerCase()]])).map((r) => [String(r.email), String(r.id)]));
    const credit = theirs.get(as.toLowerCase());
    if (!credit) throw new Error(`the target has no user ${as}`);
    const remap = users.flatMap((u) => (!u.member ? [[String(u.id), credit] as const] : theirs.has(String(u.email)) ? [[String(u.id), theirs.get(String(u.email))!] as const] : []));
    const swap = (line: string) => remap.reduce((s, [from, to]) => s.replaceAll(from, to), line);

    const tables: MergeResult["tables"] = [];
    await target.tx(async (t) => {
      for (const { name } of order) {
        let lines = (await q(`select to_jsonb(t)::text as j from ${qi(name)} t`)).map((r) => String(r.j));
        if (name === "users") lines = lines.filter((l) => !remap.some(([from]) => l.includes(`"id": "${from}"`)));
        if (!lines.length) continue;
        await t(`insert into ${qi(name)} select * from jsonb_populate_recordset(null::${qi(name)}, $1::text::jsonb)`, [`[${lines.map(swap).join(",")}]`]);
        tables.push({ name, rows: lines.length });
      }
      const errors = (await integrity(t)).filter((f) => f.level === "error");
      if (errors.length) throw new Error(`the target would not hold together, nothing was written:\n${errors.map((e) => `  ${e.check}: ${e.detail}`).join("\n")}`);
    });
    return { tables, matchedUsers: [...theirs.keys()] };
  } finally {
    await scratch.close();
  }
}
