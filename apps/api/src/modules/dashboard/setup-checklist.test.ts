import { test } from "node:test";
import assert from "node:assert/strict";
import { checklistStatus, checklistBriefingLine } from "./setup-checklist";

const base = {
  teamKey: "WH",
  repositories: [],
  sessionCount: 0,
  activeAgentKeyCount: 0,
  nodeCount: 0,
  memberCount: 1,
  pendingInviteCount: 0,
};

test("a fresh no-code team has nothing connected", () => {
  const s = checklistStatus(base);
  assert.equal(s.done, false);
  assert.equal(s.doneCount, 0);
  assert.equal(s.total, 5);
  assert.ok(s.items.every((i) => !i.done));
  assert.match(s.items.find((i) => i.id === "repos")!.status, /No repository connected/);
  assert.match(s.items.find((i) => i.id === "teammates")!.status, /Just you so far/);
});

test("a fully set up team is all green", () => {
  const s = checklistStatus({
    teamKey: "WH",
    repositories: [{ provider: "github", lifecycle: "live" }],
    sessionCount: 2,
    activeAgentKeyCount: 1,
    nodeCount: 10,
    memberCount: 3,
    pendingInviteCount: 1,
  });
  assert.equal(s.done, true);
  assert.equal(s.doneCount, 5);
  assert.ok(s.items.every((i) => i.done));
  assert.match(s.items.find((i) => i.id === "repos")!.status, /authoritative/);
  assert.match(s.items.find((i) => i.id === "teammates")!.status, /3 teammates.*1 invite pending/);
});

test("a partially set up team mixes done and not-done, and retired repos don't count", () => {
  const s = checklistStatus({
    teamKey: "WH",
    repositories: [{ provider: "local", lifecycle: "live" }, { provider: "github", lifecycle: "retired" }],
    sessionCount: 1,
    activeAgentKeyCount: 0,
    nodeCount: 3,
    memberCount: 1,
    pendingInviteCount: 2,
  });
  assert.equal(s.done, false);
  assert.equal(s.doneCount, 3); // repos, machines, map
  const repos = s.items.find((i) => i.id === "repos")!;
  assert.equal(repos.done, true);
  assert.match(repos.status, /best effort/);
  assert.ok(!repos.status.includes("GitHub"), "the retired GitHub repo is excluded from the live count");
  const agents = s.items.find((i) => i.id === "agents")!;
  assert.equal(agents.done, false);
  const teammates = s.items.find((i) => i.id === "teammates")!;
  assert.equal(teammates.done, false);
  assert.match(teammates.status, /2 invites pending, no one has joined yet/);
});

test("a mix of GitHub and local repositories reports both and still counts as done", () => {
  const s = checklistStatus({
    ...base,
    repositories: [
      { provider: "github", lifecycle: "live" },
      { provider: "local", lifecycle: "live" },
    ],
  });
  const repos = s.items.find((i) => i.id === "repos")!;
  assert.equal(repos.done, true);
  assert.match(repos.status, /1 on GitHub \(authoritative\) and 1 local-link \(best effort/);
});

test("the briefing line mirrors the same done/not-done flags for every item", () => {
  const s = checklistStatus(base);
  const line = checklistBriefingLine(s);
  assert.ok(line.startsWith("Setup: "));
  for (const item of s.items) assert.ok(line.includes(`${item.label.toLowerCase()} ${item.done ? "✓" : "✗"}`));
});

test("every unmet item links to the team it belongs to", () => {
  const s = checklistStatus(base);
  for (const item of s.items) assert.ok(item.href.startsWith("/t/WH") || item.href === "/settings/integrations/github?team=WH" || item.href === "/api-keys" || item.href === "/workspace");
});
