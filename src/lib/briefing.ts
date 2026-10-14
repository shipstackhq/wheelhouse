import "server-only";
import type { Actor } from "./auth";
import { getBoard, getChanges, getGraph, resolveTicket, getTicket, type NodeRow } from "./service";

/**
 * Context for agents, so a fresh session starts warm instead of re-reading the
 * codebase. Both renderers produce compact markdown: an overview with pointers,
 * not a dump. Sections are ordered by importance and trimmed to a budget.
 */

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.replace(/^[-*]\s*/, "").trim() ?? "";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Join sections in priority order until the character budget is spent. */
function budgeted(sections: (string | null)[], max: number) {
  const out: string[] = [];
  let used = 0;
  for (const s of sections) {
    if (!s) continue;
    if (used + s.length > max) {
      const room = max - used;
      if (room > 200) out.push(clip(s, room) + "\n");
      out.push(`_(briefing trimmed to ${max} chars; drill in with get_graph / get_node / get_flows)_`);
      break;
    }
    out.push(s);
    used += s.length;
  }
  return out.join("\n");
}

// ───────── session briefing ─────────

export async function briefing(actor: Actor, projectRef: string, opts: { maxChars?: number } = {}) {
  const max = Math.min(Math.max(opts.maxChars ?? 6000, 1500), 20000);
  const [g, board] = await Promise.all([getGraph(actor, projectRef), getBoard(actor, projectRef)]);
  const p = g.project;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const top = (layer: string) => g.nodes.filter((n) => n.layer === layer && !n.parentId).sort((a, b) => a.name.localeCompare(b.name));
  const colName = new Map(board.columns.map((c) => [c.id, c.name]));
  const doneCol = board.columns[board.columns.length - 1]?.id;

  const header = `# ${p.key}: ${p.name}\n${p.description ? p.description + "\n" : ""}_Wheelhouse briefing generated ${new Date().toISOString()}. The map explains intent; the code is the source of truth._\n`;

  // What it is
  const concepts = top("concept");
  const what = concepts.length
    ? `## What it is\n${concepts.slice(0, 10).map((c) => `- **${c.name}**${c.summary ? `: ${c.summary}` : ""}`).join("\n")}\n`
    : null;

  // How it's built
  const systems = top("system");
  const sysLines = systems.slice(0, 12).map((s) => {
    const kids = g.nodes.filter((k) => k.parentId === s.id).map((k) => k.name);
    return `- **${s.name}** (${s.kind})${s.summary ? `: ${s.summary}` : ""}${kids.length ? `\n  contains: ${kids.slice(0, 8).join(", ")}${kids.length > 8 ? "…" : ""}` : ""}`;
  });
  const deps = g.edges
    .filter((e) => e.kind === "depends" && byId.get(e.fromNodeId)?.layer === "system")
    .slice(0, 15)
    .map((e) => `${byId.get(e.fromNodeId)?.name} → ${byId.get(e.toNodeId)?.name}${e.label ? ` (${e.label})` : ""}`);
  const tables = g.nodes.filter((n) => n.layer === "data");
  const rels = g.edges.filter((e) => e.kind === "references").length;
  const built =
    systems.length || tables.length
      ? `## How it's built\n${sysLines.join("\n")}${deps.length ? `\nConnections: ${deps.join("; ")}` : ""}${
          tables.length ? `\nData: ${tables.length} tables/views/enums (${tables.slice(0, 25).map((t) => t.name).join(", ")}${tables.length > 25 ? "…" : ""}), ${rels} relationships. Use get_schema for columns.` : ""
        }\n`
      : null;

  // Your work + board state
  const open = board.tickets.filter((t) => t.columnId !== doneCol);
  const mine = actor.kind === "agent" ? open.filter((t) => t.claimedByKeyId === actor.id) : open.filter((t) => t.assigneeId === actor.id);
  const inProgress = open.filter((t) => colName.get(t.columnId)?.toLowerCase() === "in progress");
  const review = open.filter((t) => colName.get(t.columnId)?.toLowerCase() === "review");
  const urgent = open.filter((t) => t.priority === "urgent" || t.priority === "high");
  const busy = (t: (typeof open)[number]) => ["in progress", "review"].includes(colName.get(t.columnId)?.toLowerCase() ?? "");
  const ready = open.filter((t) => t.agentClaimable && !t.claimedByKeyId && !busy(t));
  const tl = (t: (typeof open)[number]) => `${t.ref} ${t.title} [${colName.get(t.columnId)}${t.priority !== "medium" ? `, ${t.priority}` : ""}]`;
  const work = [
    "## Work",
    mine.length ? `Yours: ${mine.slice(0, 6).map(tl).join("; ")}` : actor.kind === "agent" ? "Yours: nothing claimed." : null,
    inProgress.length ? `In progress: ${inProgress.slice(0, 6).map(tl).join("; ")}` : null,
    review.length ? `Waiting for review: ${review.length}` : null,
    urgent.length ? `High/urgent open: ${urgent.slice(0, 5).map(tl).join("; ")}` : null,
    actor.kind === "agent" && ready.length ? `AI-ready, unclaimed: ${ready.slice(0, 5).map(tl).join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Since you last looked (agents only; never acks). With a session this is that session's own queue.
  // The agent is never asked to handle the session id: the plugin hooks attach it to every call (ADR-5).
  let since: string | null = null;
  if (actor.kind === "agent") {
    const q = await getChanges(actor, projectRef, 10);
    if (q.total) {
      const types: Record<string, number> = q.summary?.byType ?? q.changes.reduce<Record<string, number>>((m, c) => ((m[c.type] = (m[c.type] ?? 0) + 1), m), {});
      since = `## Since you last looked\n${q.total} change(s): ${Object.entries(types)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}. Latest: ${q.changes
        .slice(-5)
        .map((c) => `${c.actorName} ${c.summary}`)
        .join("; ")}. Call get_changes to handle them, then ack_changes.\n`;
    }
  }

  // Watch out: decisions, gotchas, stale + in flux
  const decisions = g.decisions.filter((d) => d.status === "accepted").slice(-8);
  const gotchas = g.nodes.filter((n) => n.gotchas && (n.layer === "system" || n.layer === "data")).slice(0, 6);
  const stale = g.nodes.filter((n) => n.stale).slice(0, 8);
  const flux = Object.entries(g.flux).slice(0, 8);
  const watch = [
    decisions.length || gotchas.length || stale.length || flux.length ? "## Watch out" : null,
    decisions.length ? `Decisions: ${decisions.map((d) => `ADR-${d.number} ${d.title}`).join("; ")}` : null,
    ...gotchas.map((n) => `- ${n.name}: ${clip(firstLine(n.gotchas), 160)}`),
    stale.length ? `Possibly out of date: ${stale.map((n) => `${n.layer}:${n.name}`).join(", ")}` : null,
    flux.length
      ? `In flux (unlanded changes): ${flux
          .map(([id, f]) => `${byId.get(id)?.name} by ${f.sessions[0]?.by ?? f.drafts[0]?.authorName}${f.sessions[0]?.ticket ? ` (${f.sessions[0].ticket})` : ""}`)
          .join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const flows = g.flows.length ? `## Flows\n${g.flows.map((f) => `- ${f.name} (${f.steps.length} steps)`).join("\n")}\nUse get_flows for steps.\n` : null;
  const terms = g.terms.length ? `## Glossary\n${g.terms.slice(0, 15).map((t) => `- **${t.term}**: ${clip(t.definition, 120)}`).join("\n")}\n` : null;
  const deeper =
    "## Go deeper\nget_ticket_context(ticket) for everything about one ticket, including which files to read first. get_node(node) for one part. get_schema for the data model.\n";

  const markdown = budgeted([header, work + "\n", since, what, built, watch ? watch + "\n" : null, flows, deeper, terms], max);
  return {
    markdown,
    stats: { nodes: g.nodes.length, openTickets: open.length, stale: g.nodes.filter((n) => n.stale).length, inFlux: Object.keys(g.flux).length },
  };
}

// ───────── ticket context pack ─────────

export async function ticketContext(actor: Actor, ticketRef: string, opts: { maxChars?: number } = {}) {
  const max = Math.min(Math.max(opts.maxChars ?? 8000, 1500), 30000);
  const { project } = await resolveTicket(actor, ticketRef);
  const [t, g] = await Promise.all([getTicket(actor, ticketRef), getGraph(actor, project.id)]);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  // Linked nodes, or a keyword guess when the ticket isn't linked yet.
  let linked: NodeRow[] = t.nodes.map((n) => byId.get(n.id)!).filter(Boolean);
  let guessed = false;
  if (!linked.length) {
    const words = `${t.ticket.title} ${t.ticket.body}`
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 3);
    linked = g.nodes
      .map((n) => {
        const hay = `${n.name} ${n.summary}`.toLowerCase();
        return { n, score: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => x.n);
    guessed = linked.length > 0;
  }

  // One hop across layers via implements, plus nested children.
  const around = new Map<string, NodeRow>();
  for (const n of linked) {
    for (const e of g.edges) {
      if (e.kind !== "implements") continue;
      if (e.fromNodeId === n.id) around.set(e.toNodeId, byId.get(e.toNodeId)!);
      if (e.toNodeId === n.id) around.set(e.fromNodeId, byId.get(e.fromNodeId)!);
    }
    for (const k of g.nodes) if (k.parentId === n.id) around.set(k.id, k);
  }
  for (const n of linked) around.delete(n.id);
  const neighbours = [...around.values()].filter(Boolean);
  const all = [...linked, ...neighbours];

  const files = [...new Set(all.filter((n) => n.layer !== "concept").flatMap((n) => n.anchors))].slice(0, 15);
  const tables = all.filter((n) => n.layer === "data");
  const flows = g.flows.filter((f) => f.steps.some((s) => all.some((n) => n.id === s.nodeId)));
  const decisions = g.decisions.filter((d) => d.nodeIds.some((id) => all.some((n) => n.id === id)));

  const nodeBlock = (n: NodeRow) =>
    [
      `### ${n.layer}:${n.name}${n.stale ? " (possibly out of date)" : ""}${g.flux[n.id] ? " (in flux)" : ""}`,
      n.summary,
      n.purpose && `Purpose: ${n.purpose}`,
      n.responsibilities && `Responsibilities:\n${n.responsibilities}`,
      n.interfaces && `Interfaces:\n${n.interfaces}`,
      n.gotchas && `Gotchas:\n${n.gotchas}`,
      n.anchors.length && `Files: ${n.anchors.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");

  const tk = t.ticket;
  const head = `# ${tk.ref}: ${tk.title}\nStatus: ${tk.column} · priority ${tk.priority} · version ${tk.version}${tk.labels.length ? ` · labels ${tk.labels.join(", ")}` : ""}\n\n${tk.body || "_No description._"}\n`;
  const thread = t.comments.length
    ? `## Discussion (latest ${Math.min(5, t.comments.length)} of ${t.comments.length})\n${t.comments
        .slice(-5)
        .map((c) => `- ${c.authorKind === "agent" ? "🤖 " : ""}${c.authorName}: ${clip(c.body, 400)}`)
        .join("\n")}\n`
    : null;
  const read = files.length ? `## Read these files first\n${files.map((f) => `- ${f}`).join("\n")}\n` : null;
  const parts = linked.length
    ? `## ${guessed ? "Possibly related parts of the system (ticket isn't linked to the map yet; link with link_ticket_node)" : "Parts of the system this touches"}\n${linked.map(nodeBlock).join("\n\n")}\n`
    : `## Map\nNothing on the map matches this ticket yet. After the work, add or link nodes (upsert_node, link_ticket_node).\n`;
  const near = neighbours.length
    ? `## Connected across layers\n${neighbours.map((n) => `- ${n.layer}:${n.name}${n.summary ? `: ${n.summary}` : ""}`).join("\n")}\n`
    : null;
  const data = tables.length
    ? `## Tables\n${tables
        .map((tb) => `- **${tb.name}**: ${tb.columns.map((c) => `${c.name}${c.pk ? " pk" : ""}${c.references ? ` → ${c.references}` : ""}`).join(", ")}`)
        .join("\n")}\n`
    : null;
  const flowTxt = flows.length
    ? `## Flows through here\n${flows
        .map((f) => `- **${f.name}**: ${f.steps.map((s, i) => `${i + 1}. ${byId.get(s.nodeId)?.name}: ${s.title}`).join(" → ")}`)
        .join("\n")}\n`
    : null;
  const adr = decisions.length
    ? `## Decisions that apply\n${decisions.map((d) => `- ADR-${d.number} ${d.title} (${d.status})${d.decision ? `: ${clip(d.decision, 200)}` : ""}`).join("\n")}\n`
    : null;

  return {
    markdown: budgeted([head, read, parts, adr, thread, data, flowTxt, near], max),
    files,
    nodes: all.map((n) => `${n.layer}:${n.name}`),
  };
}
