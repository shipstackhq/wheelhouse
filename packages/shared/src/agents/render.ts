import { GUARDRAILS, GUARDRAILS_DIVIDER, GUARDRAILS_VERSION } from "./guardrails";
import type { AgentProfile } from "./schema";

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

export const agentName = (p: AgentProfile) => `wh-${p.slug}`;

function toolLists(p: AgentProfile) {
  const disallowed = [...(p.disallowedTools ?? [])];
  if (p.toolProfile === "read-only") disallowed.push("Write", "Edit");
  return {
    tools: p.toolProfile === "read-only" ? READ_ONLY_TOOLS : p.toolProfile === "custom" ? p.tools : undefined,
    disallowedTools: disallowed.length ? [...new Set(disallowed)] : undefined,
  };
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

const VERBOSITY = {
  terse: "Be terse: short answers, no preamble.",
  normal: "Be clear and to the point.",
  detailed: "Explain your reasoning and the trade-offs in detail.",
};

function sections(p: AgentProfile): string[] {
  const out = [p.instructions.trim()];
  if (p.rules.length) {
    const rules = p.rules.map((r) => [`- ${r.rule}`, r.why && `  - Why: ${r.why}`, r.example && `  - Example: ${r.example}`].filter(Boolean).join("\n"));
    out.push(`## Rules\n\n${rules.join("\n")}`);
  }
  const style = [VERBOSITY[p.style.verbosity], p.style.explainChanges && "Finish with a summary of what changed and why.", p.style.notes];
  out.push(`## Style\n\n${style.filter(Boolean).join(" ")}`);
  if (p.done.length) out.push(`## Done means\n\n${bullets(p.done)}`);
  if (p.askWhen.length) out.push(`## Ask instead of guessing when\n\n${bullets(p.askWhen)}`);
  out.push(`## Scope\n\n${p.pathScope.length ? `Work inside: ${p.pathScope.join(", ")}.` : "The whole repository."}`);
  return out;
}

// The system prompt of a rendered agent: guardrails first, then the author's text.
function body(p: AgentProfile): string {
  return [GUARDRAILS, GUARDRAILS_DIVIDER, ...sections(p)].join("\n\n");
}

const q = (s: string) => JSON.stringify(s);

export function toSubagentFile(p: AgentProfile): string {
  const { tools, disallowedTools } = toolLists(p);
  const front = [
    `name: ${agentName(p)}`,
    `description: ${q(p.description)}`,
    `model: ${p.model}`,
    p.effort && `effort: ${p.effort}`,
    p.maxTurns && `maxTurns: ${p.maxTurns}`,
    `color: ${p.color}`,
    p.skills.length && `skills: ${JSON.stringify(p.skills)}`,
    tools && `tools: ${tools.join(", ")}`,
    disallowedTools && `disallowedTools: ${disallowedTools.join(", ")}`,
  ].filter(Boolean);
  return `---\n${front.join("\n")}\n---\n\n${body(p)}\n\n---\nWheelhouse agent ${p.name}, guardrails v${GUARDRAILS_VERSION}.\n`;
}

// One entry of the CLI's `--agents` JSON, keyed by agent name.
export function toAgentsJson(p: AgentProfile) {
  const { tools, disallowedTools } = toolLists(p);
  return {
    [agentName(p)]: {
      description: p.description,
      prompt: body(p),
      model: p.model,
      ...(tools && { tools }),
      ...(disallowedTools && { disallowedTools }),
      ...(p.skills.length && { skills: p.skills }),
      ...(p.maxTurns && { maxTurns: p.maxTurns }),
      ...(p.effort && { effort: p.effort }),
    },
  };
}

// What the web shows; no guardrails.
export function toView(p: AgentProfile) {
  const { slug, name, role, summary, avatar, color, description, kind, toolProfile, model, pathScope } = p;
  return { slug, name, role, summary, avatar, color, description, kind, toolProfile, model, pathScope };
}
export type AgentView = ReturnType<typeof toView>;
