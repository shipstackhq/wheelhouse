import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { agentProfileSchema, type AgentProfile } from "./schema";
import { CATALOG } from "./catalog";
import { AVATAR_STYLES, randomSeed } from "./avatar";

const base = CATALOG.backend[0];
const bad = (patch: Record<string, unknown>) => agentProfileSchema.safeParse({ ...base, ...patch }).success;

describe("agent profile schema", () => {
  test("every catalog version validates, with unique slugs and names", () => {
    const all = Object.entries(CATALOG);
    assert.equal(all.length, 6);
    for (const [slug, versions] of all) for (const p of versions) {
      assert.deepEqual(agentProfileSchema.parse(p), p);
      assert.equal(p.slug, slug);
    }
    assert.equal(new Set(all.map(([, v]) => v[0].name)).size, 6);
  });
  test("lengths, counts and slug shape are enforced", () => {
    assert.equal(bad({}), true);
    for (const slug of ["A", "a", "has space", "x".repeat(33), "Under_score"]) assert.equal(bad({ slug }), false, slug);
    assert.equal(bad({ name: "A" }), false);
    assert.equal(bad({ name: "x".repeat(17) }), false);
    assert.equal(bad({ role: "x".repeat(41) }), false);
    assert.equal(bad({ summary: "x".repeat(121) }), false);
    assert.equal(bad({ description: "x".repeat(301) }), false);
    assert.equal(bad({ instructions: "x".repeat(8001) }), false);
    assert.equal(bad({ rules: Array.from({ length: 21 }, () => ({ rule: "r" })) }), false);
    assert.equal(bad({ skills: Array.from({ length: 33 }, (_, i) => `s${i}`) }), false);
    assert.equal(bad({ color: "black" }), false);
    assert.equal(bad({ schemaVersion: 2 }), false);
  });
  test("avatar style is one of the five", () => {
    assert.equal(AVATAR_STYLES.length, 5);
    assert.equal(bad({ avatar: { ...base.avatar, style: "micah" } }), false);
    assert.notEqual(randomSeed(), randomSeed());
  });
  test("tools list only with the custom tool profile", () => {
    assert.equal(bad({ tools: ["Read"] }), false);
    assert.equal(bad({ toolProfile: "custom" }), false);
    assert.equal(bad({ toolProfile: "custom", tools: ["Read", "Bash"] }), true);
  });
  test("a read-only or advisor agent cannot have edit tools", () => {
    const reviewer = CATALOG.reviewer[0];
    const r = (patch: Partial<AgentProfile>) => agentProfileSchema.safeParse({ ...reviewer, ...patch }).success;
    assert.equal(r({}), true);
    assert.equal(r({ toolProfile: "edit" }), false);
    assert.equal(r({ toolProfile: "custom", tools: ["Read", "Edit"] }), false);
    assert.equal(r({ toolProfile: "custom", tools: ["Read", "Grep"] }), true);
    assert.equal(bad({ toolProfile: "custom", tools: ["Write"] }), true);
  });
});
