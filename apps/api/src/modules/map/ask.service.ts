import Anthropic from "@anthropic-ai/sdk";
import { Inject, Injectable } from "@nestjs/common";
import { onboarding } from "@wheelhouse/shared/onboarding";
import type { Actor } from "../../common/actor";
import { rateLimit } from "../../common/rate-limit";
import { ServiceError } from "../../common/service-error";
import { bad, rateLimited, text } from "../../lib/web-input";
import { listEvents } from "../../lib/service-queue";
import { RepositoriesService } from "../github/index";
import { TeamAccessService } from "../teams/index";
import { GraphService } from "./graph.service";
import { askEnabled, renderMap } from "./map.rules";

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
 * Ask the map ("Ask about this": answers questions from the knowledge map itself; it never reads code, so answers are only as good as
 * the map, and the prompt says so), the activity page and the onboarding wizard that starts a map. Every method resolves the team
 * through TeamAccessService. The agent briefing looks across areas and lives in the dashboard module.
 */
@Injectable()
export class AskService {
  constructor(
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
  ) {}

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
