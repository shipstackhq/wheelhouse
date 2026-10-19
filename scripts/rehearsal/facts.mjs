// What the data says before the app touches it, for the continuity checks: the newest event, the cursors of the API keys,
// a connected GitHub repository and an open ticket. Reads a PGlite directory (a copy), prints one JSON line.
import crypto from "node:crypto";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const c = new PGlite(process.argv[2]);
const q = async (s) => (await c.query(s)).rows;
const [{ m }] = await q("select coalesce(max(seq),0)::int as m from events");
const repos = await q(`select r.github_repo_id as repo, r.github_installation_id as inst, p.key as team from repositories r join teams p on p.id = r.team_id where r.provider = 'github' and r.lifecycle <> 'retired' limit 1`);
const tickets = await q(`select p.key || '-' || t.number as ref from tickets t join teams p on p.id = t.team_id join columns c on c.id = t.column_id where c.name = 'Backlog' order by t.number desc limit 1`);
const cursors = await q(`select a.last_seq::int as seq, p.key as team, k.prefix from agent_cursors a join teams p on p.id = a.team_id join api_keys k on k.id = a.api_key_id order by a.last_seq desc limit 3`);
// The person's own API key (the one the plugin uses): which row it is, where its cursor stands in each team, and how many changes
// are waiting for it by the rule the queue uses (events by others after the cursor). Only the hash is ever looked at; the key is not printed.
let mine = null;
try {
  const creds = JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/wheelhouse/credentials.json`, "utf8"));
  const hash = crypto.createHash("sha256").update(String(Object.values(creds)[0])).digest("hex");
  const [row] = await c.query("select id, prefix from api_keys where key_hash = $1", [hash]).then((r) => r.rows);
  if (row) {
    const perTeam = await q(`select p.key as team, coalesce(a.last_seq, 0)::int as cursor,
      (select count(*)::int from events e where e.team_id = p.id and e.seq > coalesce(a.last_seq, 0) and not (e.actor_kind = 'agent' and e.actor_id = '${row.id}')) as waiting
      from teams p left join agent_cursors a on a.team_id = p.id and a.api_key_id = '${row.id}' order by p.key`);
    mine = { prefix: row.prefix, teams: perTeam };
  }
} catch {}
console.log(JSON.stringify({ maxSeq: m, repo: repos[0] ?? null, ticket: tickets[0]?.ref ?? null, cursors, mine }));
await c.close();
