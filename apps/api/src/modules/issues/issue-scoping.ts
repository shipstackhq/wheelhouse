import Anthropic from "@anthropic-ai/sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { GraphService, askEnabled, renderMap } from "../map/index";
import { IssueTargets } from "./issue-targets";
import { IssuesService } from "./issues.service";

const MODEL = "claude-haiku-5-5";

const SYSTEM = `You decide which repositories the work in an issue happens in. You see the issue, the team's knowledge map (not the code) and the list of repositories.
Reply with only a JSON array of repository names, copied exactly from the list, most likely first. Reply [] when the issue and the map do not say.`;

let client: Anthropic | null = null;

/**
 * WH-136: a cheap, read-only step for an issue with no targets: a small model reads the issue and the map (never the code) and
 * suggests which of the team's repositories the work belongs in. It only suggests, nothing is saved, and a person confirms.
 */
@Injectable()
export class IssueScoping {
  constructor(
    @Inject(IssuesService) private readonly issues: IssuesService,
    @Inject(IssueTargets) private readonly targets: IssueTargets,
    @Inject(GraphService) private readonly graph: GraphService,
  ) {}

  /** The model's raw answer. One place, so a test can stand in for the API. */
  async complete(system: string, user: string): Promise<string> {
    client ??= new Anthropic();
    try {
      const msg = await client.messages.create({ model: MODEL, max_tokens: 300, system, messages: [{ role: "user", content: user }] });
      return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } catch (e) {
      if (e instanceof Anthropic.APIError) throw new ServiceError("invalid", `Claude API error (${e.status})`);
      throw e;
    }
  }

  async suggest(actor: Actor, ref: string) {
    if (!askEnabled()) throw new ServiceError("invalid", "Suggestions are off: set ANTHROPIC_API_KEY on the server");
    const { issue, team } = await this.issues.resolveIssue(actor, ref, "edit");
    const candidates = await this.targets.candidates(issue);
    if (!candidates.length) return { suggestions: [] };
    const map = renderMap(await this.graph.getGraph(actor, team.key));
    const answer = await this.complete(
      SYSTEM,
      `<map>\n${map}\n</map>\n\n<repositories>\n${candidates.map((r) => r.githubFullName).join("\n")}\n</repositories>\n\n<issue>\n${issue.title}\n\n${issue.body}\n</issue>`,
    );
    const named = (() => {
      try {
        const v = JSON.parse(answer.slice(answer.indexOf("["), answer.lastIndexOf("]") + 1));
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    })();
    const picked = [...new Set(named)].flatMap((n) => candidates.filter((r) => r.githubFullName === n));
    return { suggestions: picked.map((r) => ({ repositoryId: r.id, repository: r.githubFullName!, baseBranch: r.defaultBranch })) };
  }
}
