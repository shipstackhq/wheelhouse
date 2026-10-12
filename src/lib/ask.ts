import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Actor } from "./auth";
import { getGraph, ServiceError } from "./service";

/**
 * "Ask about this": answers questions from the knowledge map itself (concepts,
 * systems, code anchors, flows, decisions, glossary). It never reads code,
 * so answers are only as good as the map, and the prompt says so.
 */

const MODEL = "claude-opus-5-5";

const SYSTEM = `You answer questions about a software project using ONLY its knowledge map, provided below in <map>.
The map has four linked layers: concept (what the product does), system (what runs where), data (tables, columns, foreign keys), code (files/symbols/endpoints).
"implements" links connect a lower layer to the higher-level thing it realizes. Flows are ordered walkthroughs. ADRs record decisions.

Rules:
- Explain at the level the person asks; default to the high level first, then point down to systems/code anchors.
- Cite map nodes inline as [[layer:Name]] and decisions as ADR-N so the UI can link them.
- If the map doesn't cover something, say exactly what's missing (and which node should be described) instead of guessing about the code.
- Nodes marked STALE may be out of date; mention it when you rely on one.
- Be concise: short paragraphs or bullets, no preamble.`;

type Graph = Awaited<ReturnType<typeof getGraph>>;

/** Deterministic rendering (stable ordering) so the cached prefix survives across questions. */
export function renderMap(g: Graph) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? `${n.layer}:${n.name}` : "?";
  };
  const out: string[] = [`# Project ${g.project.key}: ${g.project.name}`, g.project.description, ""];
  for (const layer of ["concept", "system", "data", "code"] as const) {
    const ns = g.nodes.filter((n) => n.layer === layer);
    if (!ns.length) continue;
    out.push(`## ${layer.toUpperCase()} LAYER`);
    const kids = (pid: string | null) => ns.filter((n) => n.parentId === pid).sort((a, b) => a.name.localeCompare(b.name));
    const walk = (pid: string | null, depth: number) => {
      for (const n of kids(pid)) {
        const h = "#".repeat(Math.min(3 + depth, 6));
        out.push(`${h} ${layer}:${n.name} (${n.kind}, ${n.status}${n.stale ? ", STALE" : ""})`);
        if (n.summary) out.push(n.summary);
        if (n.purpose) out.push(`Purpose: ${n.purpose}`);
        if (n.responsibilities) out.push(`Responsibilities:\n${n.responsibilities}`);
        if (n.interfaces) out.push(`Interfaces:\n${n.interfaces}`);
        if (n.gotchas) out.push(`Gotchas:\n${n.gotchas}`);
        if (n.details) out.push(`Notes:\n${n.details}`);
        if (n.columns.length)
          out.push(
            `Columns:\n${n.columns
              .map((c) => `- ${c.name} ${c.type}${c.pk ? " PK" : ""}${c.unique ? " UNIQUE" : ""}${c.nullable ? " NULL" : ""}${c.references ? ` → ${c.references}${c.onDelete ? ` (on delete ${c.onDelete})` : ""}` : ""}${c.note ? ` — ${c.note}` : ""}`)
              .join("\n")}`,
          );
        if (n.anchors.length) out.push(`Code anchors: ${n.anchors.join(", ")}`);
        const deps = g.edges.filter((e) => e.kind === "depends" && e.fromNodeId === n.id);
        if (deps.length) out.push(`Depends on: ${deps.map((e) => label(e.toNodeId) + (e.label ? ` (${e.label})` : "")).sort().join("; ")}`);
        const impl = g.edges.filter((e) => e.kind === "implements" && e.fromNodeId === n.id);
        if (impl.length) out.push(`Implements: ${impl.map((e) => label(e.toNodeId)).sort().join("; ")}`);
        out.push("");
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
  }
  if (g.flows.length) {
    out.push("## FLOWS");
    for (const f of [...g.flows].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`### Flow: ${f.name}`, f.description);
      f.steps.forEach((s, i) => out.push(`${i + 1}. [${label(s.nodeId)}] ${s.title}${s.detail ? ` — ${s.detail}` : ""}`));
      out.push("");
    }
  }
  if (g.decisions.length) {
    out.push("## DECISIONS");
    for (const d of g.decisions) {
      out.push(`### ADR-${d.number}: ${d.title} (${d.status})`);
      if (d.context) out.push(`Context: ${d.context}`);
      if (d.decision) out.push(`Decision: ${d.decision}`);
      if (d.consequences) out.push(`Consequences: ${d.consequences}`);
      if (d.nodeIds.length) out.push(`Applies to: ${d.nodeIds.map(label).sort().join("; ")}`);
      out.push("");
    }
  }
  if (g.terms.length) {
    out.push("## GLOSSARY");
    for (const t of g.terms) out.push(`- **${t.term}**: ${t.definition}`);
  }
  return out.join("\n");
}

export function askEnabled() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;

export async function askMap(actor: Actor, projectRef: string, question: string, focusNodeId?: string) {
  if (!askEnabled()) throw new ServiceError("invalid", "Ask is disabled: set ANTHROPIC_API_KEY on the server");
  const q = question.trim();
  if (!q) throw new ServiceError("invalid", "Ask a question");
  const g = await getGraph(actor, projectRef);
  if (!g.nodes.length) throw new ServiceError("invalid", "The map is empty. Map the codebase first.");
  const focus = focusNodeId ? g.nodes.find((n) => n.id === focusNodeId) : undefined;

  client ??= new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    // On a safety-classifier decline, the API re-runs on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: SYSTEM },
      // The map is the large, stable part: cache it so follow-up questions are cheap.
      { type: "text", text: `<map>\n${renderMap(g)}\n</map>`, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: focus ? `I'm looking at [[${focus.layer}:${focus.name}]].\n\n${q}` : q,
      },
    ],
  });

  let msg;
  try {
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new ServiceError("invalid", "Claude is rate limited, try again in a moment");
    if (e instanceof Anthropic.AuthenticationError) throw new ServiceError("invalid", "ANTHROPIC_API_KEY is invalid");
    if (e instanceof Anthropic.APIError) throw new ServiceError("invalid", `Claude API error (${e.status})`);
    throw e;
  }
  if (msg.stop_reason === "refusal") return { answer: "Claude declined to answer this question.", truncated: false };
  const answer = msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  return { answer, truncated: msg.stop_reason === "max_tokens" };
}
