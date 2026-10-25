import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { toAgentsJson, toSubagentFile, toView } from "./render";
import { GUARDRAILS, GUARDRAILS_DIVIDER, GUARDRAILS_VERSION } from "./guardrails";
import { CATALOG } from "./catalog";
import type { AgentProfile } from "./schema";

const all = Object.values(CATALOG).flat();
const bram = CATALOG.backend[0];
const remy = CATALOG.reviewer[0];

function parse(file: string) {
  const m = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(file);
  assert.ok(m, "frontmatter and body");
  const front: Record<string, string> = {};
  for (const l of m[1].split("\n")) { const i = l.indexOf(": "); front[l.slice(0, i)] = l.slice(i + 2); }
  return { front, body: m[2] };
}

describe("render", () => {
  test("the subagent file has frontmatter with the right fields per tool profile", () => {
    const b = parse(toSubagentFile(bram)).front;
    assert.equal(b.name, "wh-backend");
    assert.equal(JSON.parse(b.description), bram.description);
    assert.equal(b.model, "inherit");
    assert.equal(b.color, "blue");
    for (const k of ["tools", "disallowedTools", "effort", "maxTurns", "skills"]) assert.equal(k in b, false, k);
    const r = parse(toSubagentFile(remy)).front;
    assert.equal(r.tools, "Read, Grep, Glob");
    assert.equal(r.disallowedTools, "Write, Edit");
  });
  test("custom tools, disallowed tools, effort, turns and skills are rendered", () => {
    const p: AgentProfile = { ...bram, toolProfile: "custom", tools: ["Read", "Bash"], disallowedTools: ["WebFetch"], effort: "high", maxTurns: 20, skills: ["lucid"] };
    const f = parse(toSubagentFile(p)).front;
    assert.deepEqual([f.tools, f.disallowedTools, f.effort, f.maxTurns, f.skills], ["Read, Bash", "WebFetch", "high", "20", '["lucid"]']);
    assert.equal(parse(toSubagentFile({ ...bram, disallowedTools: ["Bash"] })).front.disallowedTools, "Bash");
  });
  test("guardrails come first in every rendered agent, then the divider, then the author's text", () => {
    for (const p of all) {
      const { body } = parse(toSubagentFile(p));
      assert.ok(body.startsWith(GUARDRAILS), p.slug);
      assert.ok(body.indexOf(GUARDRAILS_DIVIDER) < body.indexOf(p.instructions.trim()), p.slug);
      assert.ok(body.startsWith(`${GUARDRAILS}\n\n${GUARDRAILS_DIVIDER}\n\n${p.instructions.trim()}`), p.slug);
      assert.ok(toAgentsJson(p)[`wh-${p.slug}`].prompt.startsWith(GUARDRAILS), p.slug);
    }
  });
  test("the body has its sections in order and a version footer", () => {
    const { body } = parse(toSubagentFile(bram));
    const heads = ["## Rules", "## Style", "## Done means", "## Ask instead of guessing when", "## Scope"].map((h) => body.indexOf(h));
    assert.ok(heads.every((i, n) => i > (heads[n - 1] ?? 0)), "in order");
    assert.ok(body.trimEnd().endsWith(`guardrails v${GUARDRAILS_VERSION}.`));
    assert.match(body, /- Validate input at the edge and trust it inside\.\n  - Why: .*\n  - Example: /);
  });
  test("sections render as expected", () => {
    const p: AgentProfile = { ...bram, rules: [{ rule: "R", why: "W", example: "E" }], style: { verbosity: "detailed", explainChanges: true, notes: "N." }, done: ["D"], askWhen: ["A"], pathScope: ["apps/web/**", "docs/**"] };
    const body = parse(toSubagentFile(p)).body;
    const tail = body.slice(body.indexOf("## Rules"));
    assert.equal(
      tail.split("\n\n---\n")[0],
      "## Rules\n\n- R\n  - Why: W\n  - Example: E\n\n## Style\n\nExplain your reasoning and the trade-offs in detail. Finish with a summary of what changed and why. N.\n\n## Done means\n\n- D\n\n## Ask instead of guessing when\n\n- A\n\n## Scope\n\nWork inside: apps/web/**, docs/**.",
    );
  });
  test("toAgentsJson matches the CLI's --agents entry shape", () => {
    const j = toAgentsJson(remy);
    assert.deepEqual(Object.keys(j), ["wh-reviewer"]);
    const e = j["wh-reviewer"];
    assert.deepEqual(Object.keys(e).sort(), ["description", "disallowedTools", "model", "prompt", "tools"]);
    assert.deepEqual(e.tools, ["Read", "Grep", "Glob"]);
    assert.equal(e.prompt, parse(toSubagentFile(remy)).body.split("\n\n---\n")[0]);
    assert.equal("tools" in toAgentsJson(bram)["wh-backend"], false);
  });
  test("toView has the card fields and no guardrails or instructions", () => {
    const v = toView(bram);
    assert.deepEqual(Object.keys(v).sort(), ["avatar", "color", "description", "kind", "model", "name", "pathScope", "role", "slug", "summary", "toolProfile"]);
    assert.equal(JSON.stringify(v).includes("guardrails"), false);
  });
});
