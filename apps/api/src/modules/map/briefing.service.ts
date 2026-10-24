import Anthropic from "@anthropic-ai/sdk";
import { Inject, Injectable } from "@nestjs/common";
import { onboarding } from "@wheelhouse/shared/onboarding";
import { CLOSED_ROLES } from "@wheelhouse/shared/status-roles";
import { timeAgo } from "@wheelhouse/shared/time";
import type { Actor } from "../../common/actor";
import { rateLimit } from "../../common/rate-limit";
import { ServiceError } from "../../common/service-error";
import { bad, rateLimited, text } from "../../lib/web-input";
import { getChanges, listEvents } from "../../lib/service-queue";
import { checklistBriefingLine, checklistForTeam } from "../dashboard/index";
import { listDocsIndex } from "../docs/index";
import { RepositoriesService } from "../github/index";
import { getBoard, getIssue, resolveIssue } from "../issues/index";
import { TeamAccessService } from "../teams/index";
import { FreshnessService } from "./freshness.service";
import { GraphService } from "./graph.service";
import type { NodeRow } from "./map.repository";
import { askEnabled, budgeted, clip, firstLine, renderMap } from "./map.rules";

type Body = Record<string, unknown>;

/** One person may ask this many questions in a window: every answer is a paid call. */
export const ASK_LIMIT = { count: 20, windowMs: 10 * 60_000 };

const MODEL = "claude-opus-5-5";

const SYSTEM = `You answer questions about a software team using ONLY its knowledge map, provided below in <map>.
The map has four linked layers: concept (what the product does), system (what runs where), data (tables, columns, foreign keys), code (files/symbols/endpoints).
"implements" links connect a lower layer to the higher-level thing it realizes. Flows are ordered walkthroughs. ADRs record decisions.

Rules:
- Explain at the level the person asks; default to the high level first, then point down to systems/code anchors.
- Cite map nodes inline as [[layer:Name]] and decisions as ADR-N so the UI can link them.
- If the map doesn't cover something, say exactly what's missing (and which node should be described) instead of guessing about the code.
- Nodes marked STALE may be out of date; mention it when you rely on one.
- Be concise: short paragraphs or bullets, no preamble.`;

let client: Anthropic | null = null;

/**
 * What the map tells people and agents: the session briefing and the issue context pack (compact markdown, an overview with pointers,
 * sections ordered by importance and trimmed to a budget, so a fresh session starts warm instead of re-reading the codebase), "Ask about
 * this" (answers questions from the knowledge map itself; it never reads code, so answers are only as good as the map, and the prompt
 * says so), the activity page and the onboarding wizard that starts a map. Every method resolves the team through TeamAccessService.
 */
@Injectable()
export class BriefingService {
  constructor(
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(FreshnessService) private readonly freshness: FreshnessService,
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
  ) {}

  // ───────── session briefing ─────────

  async briefing(actor: Actor, teamRef: string, opts: { maxChars?: number } = {}) {
    const max = Math.min(Math.max(opts.maxChars ?? 6000, 1500), 20000);
    const [g, board, repos, checklist, docsIndex, staleDocs] = await Promise.all([
      this.graph.getGraph(actor, teamRef),
      getBoard(actor, teamRef),
      this.repositories.listRepositories(actor, teamRef),
      checklistForTeam(actor, teamRef),
      listDocsIndex(actor, teamRef),
      this.freshness.listStaleDocs(actor, teamRef),
    ]);
    const p = g.team;
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const top = (layer: string) => g.nodes.filter((n) => n.layer === layer && !n.parentId).sort((a, b) => a.name.localeCompare(b.name));
    const colName = new Map(board.statuses.map((c) => [c.id, c.name]));
    const colRole = new Map(board.statuses.map((c) => [c.id, c.role]));

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
    const open = board.issues.filter((t) => !CLOSED_ROLES.some((r) => r === colRole.get(t.statusId)));
    const mine = actor.kind === "agent" ? open.filter((t) => t.claimedByKeyId === actor.id) : open.filter((t) => t.assigneeId === actor.id);
    const inProgress = open.filter((t) => colRole.get(t.statusId) === "in_progress");
    const review = open.filter((t) => colRole.get(t.statusId) === "review");
    const urgent = open.filter((t) => t.priority === "urgent" || t.priority === "high");
    const busy = (t: (typeof open)[number]) => ["in_progress", "review"].includes(colRole.get(t.statusId) ?? "");
    const ready = open.filter((t) => t.agentClaimable && !t.claimedByKeyId && !busy(t));
    const tl = (t: (typeof open)[number]) => `${t.ref} ${t.title} [${colName.get(t.statusId)}${t.priority !== "none" ? `, ${t.priority}` : ""}]`;
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
      const q = await getChanges(actor, teamRef, 10);
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
      decisions.length || gotchas.length || stale.length || staleDocs.length || flux.length ? "## Watch out" : null,
      decisions.length ? `Decisions: ${decisions.map((d) => `ADR-${d.number} ${d.title}`).join("; ")}` : null,
      ...gotchas.map((n) => `- ${n.name}: ${clip(firstLine(n.gotchas), 160)}`),
      stale.length ? `Possibly out of date: ${stale.map((n) => `${n.layer}:${n.name}`).join(", ")}` : null,
      staleDocs.length ? `Docs possibly out of date: ${staleDocs.map((d) => d.slug).join(", ")}` : null,
      flux.length
        ? `In flux (unlanded changes): ${flux
            .map(([id, f]) => `${byId.get(id)?.name} by ${f.sessions[0]?.by ?? f.drafts[0]?.authorName}${f.sessions[0]?.issue ? ` (${f.sessions[0].issue})` : ""}`)
            .join("; ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    // Docs index (WH-51): titles + slugs only, never bodies, to protect the token budget.
    const docsSection = docsIndex.length
      ? `## Docs\n${docsIndex.slice(0, 20).map((d) => `- ${d.title} (${d.slug})`).join("\n")}${docsIndex.length > 20 ? `\n…and ${docsIndex.length - 20} more` : ""}\nUse get_doc(slug) to read one, search_docs to find by keyword.\n`
      : null;

    const flows = g.flows.length ? `## Flows\n${g.flows.map((f) => `- ${f.name} (${f.steps.length} steps)`).join("\n")}\nUse get_flows for steps.\n` : null;
    const terms = g.terms.length ? `## Glossary\n${g.terms.slice(0, 15).map((t) => `- **${t.term}**: ${clip(t.definition, 120)}`).join("\n")}\n` : null;
    const deeper =
      "## Go deeper\nget_issue_context(issue) for everything about one issue, including which files to read first. get_node(node) for one part. get_schema for the data model.\n";

    // Where the code comes from and how much to trust "what landed" (ADR-7): said plainly, never left to be guessed.
    const live = repos.filter((r) => r.lifecycle !== "retired");
    const repoSection = live.length
      ? `## Repositories\n${live
          .map((r) =>
            r.provider === "github"
              ? `- ${r.displayName} (${r.role}): GitHub${r.githubFullName ? ` ${r.githubFullName}` : ""}, every push to ${r.defaultBranch} is reported${r.lastEventAt ? `, last ${timeAgo(r.lastEventAt)}` : ""}${r.lifecycle !== "live" ? `, ${r.lifecycle.replace("_", " ")}` : ""}`
              : `- ${r.displayName} (${r.role}): local link only, changes are reported just from machines running the plugin or CLI${r.lifecycle !== "live" ? `, ${r.lifecycle.replace("_", " ")}` : ""}`,
          )
          .join("\n")}\n`
      : `## Repositories\nNone connected: what landed and stale map nodes are not tracked.\n`;

    // Setup checklist (WH-69): same computation as the team-page banner, so the two can't drift.
    const setupLine = checklist.done ? null : `## Setup\n${checklistBriefingLine(checklist)}\n`;

    const markdown = budgeted([header, work + "\n", since, what, built, repoSection, setupLine, watch ? watch + "\n" : null, flows, docsSection, deeper, terms], max);
    return {
      markdown,
      stats: { nodes: g.nodes.length, openIssues: open.length, stale: g.nodes.filter((n) => n.stale).length, staleDocs: staleDocs.length, inFlux: Object.keys(g.flux).length },
    };
  }

  // ───────── issue context pack ─────────

  async issueContext(actor: Actor, issueRef: string, opts: { maxChars?: number } = {}) {
    const max = Math.min(Math.max(opts.maxChars ?? 8000, 1500), 30000);
    const { team } = await resolveIssue(actor, issueRef);
    const [t, g] = await Promise.all([getIssue(actor, issueRef), this.graph.getGraph(actor, team.id)]);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));

    // Linked nodes, or a keyword guess when the issue isn't linked yet.
    let linked: NodeRow[] = t.nodes.map((n) => byId.get(n.id)!).filter(Boolean);
    let guessed = false;
    if (!linked.length) {
      const words = `${t.issue.title} ${t.issue.body}`
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

    const tk = t.issue;
    const head = `# ${tk.ref}: ${tk.title}\nStatus: ${tk.status} · priority ${tk.priority} · version ${tk.version}${tk.labels.length ? ` · labels ${tk.labels.join(", ")}` : ""}\n\n${tk.body || "_No description._"}\n`;
    const thread = t.comments.length
      ? `## Discussion (latest ${Math.min(5, t.comments.length)} of ${t.comments.length})\n${t.comments
          .slice(-5)
          .map((c) => `- ${c.authorKind === "agent" ? "🤖 " : ""}${c.authorName}: ${clip(c.body, 400)}`)
          .join("\n")}\n`
      : null;
    const prs = t.pullRequests.length
      ? `## Pull requests\n${t.pullRequests.map((x) => `- #${x.number} ${clip(x.title, 100)} (${x.state}${x.draft ? ", draft" : ""}${x.ciState ? `, CI ${x.ciState === "failure" ? "failing" : x.ciState === "success" ? "passing" : "running"}` : ""}) ${x.url}`).join("\n")}\n`
      : null;
    const read = files.length ? `## Read these files first\n${files.map((f) => `- ${f}`).join("\n")}\n` : null;
    const parts = linked.length
      ? `## ${guessed ? "Possibly related parts of the system (issue isn't linked to the map yet; link with link_issue_node)" : "Parts of the system this touches"}\n${linked.map(nodeBlock).join("\n\n")}\n`
      : `## Map\nNothing on the map matches this issue yet. After the work, add or link nodes (upsert_node, link_issue_node).\n`;
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
      markdown: budgeted([head, prs, read, parts, adr, thread, data, flowTxt, near], max),
      files,
      nodes: all.map((n) => `${n.layer}:${n.name}`),
    };
  }

  // ───────── Ask the map ─────────

  async askMap(actor: Actor, teamRef: string, question: string, focusNodeId?: string) {
    if (!askEnabled()) throw new ServiceError("invalid", "Ask is disabled: set ANTHROPIC_API_KEY on the server");
    const q = question.trim();
    if (!q) throw new ServiceError("invalid", "Ask a question");
    const g = await this.graph.getGraph(actor, teamRef);
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

  /**
   * Ask a question of the map. Order matters: the team is resolved first (another workspace's is a 404 before anything else happens),
   * then the limit is counted, and only then does the server call Claude. The API key is read from the server's environment and is in
   * no answer.
   */
  async askAs(actor: Actor, teamKey: string, b: Body) {
    await this.access.require(actor, teamKey);
    const question = text(b, "question", { required: true, max: 4000, trim: true })!;
    const focus = text(b, "focus");
    const hit = rateLimit(`ask:${actor.id}`, ASK_LIMIT.count, ASK_LIMIT.windowMs);
    if (!hit.ok) throw rateLimited(hit.retryAfter);
    return this.askMap(actor, teamKey, question, focus || undefined);
  }

  // ───────── activity ─────────

  /** The team's recent events, newest first, optionally only by agents or only by people. */
  activity(actor: Actor, teamKey: string, who?: string) {
    const actorKind = who === "agent" || who === "human" ? who : undefined;
    return listEvents(actor, teamKey, { limit: 200, actorKind });
  }

  // ───────── onboarding ─────────

  /** The wizard: the team, whether it already has a repository, and the commands to paste (with this team's key in them). */
  async onboardingPage(actor: Actor, teamKey: string, origin: string) {
    const team = await this.access.require(actor, teamKey);
    const repos = await this.repositories.listRepositories(actor, teamKey);
    return { team: { key: team.key, name: team.name }, hasRepos: repos.length > 0, setup: onboarding({ origin, teamKey }) };
  }

  /**
   * The "no code yet" path: a few sentences about what is being built become the first concept on the map, so a team with no
   * repository still has something there.
   */
  async createConceptAs(actor: Actor, teamKey: string, b: Body) {
    const description = text(b, "description", { max: 20_000, trim: true });
    if (!description) bad("description", "Write a few sentences about what you're building.");
    const team = await this.access.require(actor, teamKey, "edit");
    await this.graph.upsertNode(actor, teamKey, { name: team.name, layer: "concept", kind: "concept", summary: description!.slice(0, 200), purpose: description });
    return { ok: true as const };
  }
}
