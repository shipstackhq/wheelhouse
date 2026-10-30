import { describe, expect, it } from "vitest";
import type { BoardIssue, RosterAgent } from "@wheelhouse/api-client";
import { agentWork } from "./team-agents-menu";

const agent = (id: string) => ({ id, name: id }) as RosterAgent;
const issue = (ref: string, delegateAgentId: string | null, state: string | null) =>
  ({ id: ref, ref, delegateAgentId, delegation: state ? { state, line: null, prs: [] } : null }) as BoardIssue;

describe("agentWork", () => {
  it("lists each agent's in-flight delegated issues and leaves the rest idle", () => {
    const work = agentWork([agent("fren"), agent("bram")], [issue("WH-1", "fren", "running"), issue("WH-2", "fren", "merged"), issue("WH-3", "fren", "asked"), issue("WH-4", null, null)]);
    expect(work.map((w) => [w.agent.id, w.issues.map((i) => i.ref)])).toEqual([["fren", ["WH-1", "WH-3"]], ["bram", []]]);
  });
});
