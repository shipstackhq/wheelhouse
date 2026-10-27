/**
 * Delegating an issue to an agent (WH-113) against a real database: only the assignee or an admin may, only to an agent on the team's
 * roster, never by an agent, and taking the agent off the roster clears it. Runs on an in-memory PGlite, or Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { createTeam } from "../teams/teams.legacy";
import { createIssue, getIssue, updateIssue } from "./issues.legacy";
import { AgentsRepository } from "../agents/agents.repository";
import { testApp } from "../../test/app";
const app = await testApp();

let owner: Actor; // workspace owner, team admin
let ann: Actor; // team editor, the assignee
let ed: Actor; // team editor, not the assignee
let team: { id: string };
let remy: string; // on the roster
let otto: string; // in the workspace, not on the roster
const code = (c: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === c;

before(async () => {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: "Delegate workspace" }).returning();
  const person = async (name: string, role: "owner" | "member") => {
    const [u] = await db.insert(schema.users).values({ email: `${name}-${Math.random().toString(16).slice(2, 8)}@example.com`, name, passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: w.id, role });
    return { kind: "human", id: u.id, name, workspaceId: w.id } as Actor;
  };
  owner = await person("owner", "owner");
  ann = await person("ann", "member");
  ed = await person("ed", "member");
  team = await createTeam(owner, { name: "Delegates", key: "DG" });
  await db.insert(schema.teamMembers).values([ann, ed].map((p) => ({ teamId: team.id, userId: p.id, workspaceId: w.id, role: "editor" as const })));
  const agent = async (slug: string) => (await db.insert(schema.workspaceAgents).values({ workspaceId: w.id, slug, source: "catalog", catalogSlug: slug }).returning())[0].id;
  remy = await agent("remy");
  otto = await agent("otto");
  await db.insert(schema.teamAgents).values({ teamId: team.id, workspaceId: w.id, workspaceAgentId: remy });
});

describe("issue delegate", () => {
  test("the assignee delegates to an agent on the roster, and clears it", async () => {
    const i = await createIssue(owner, "DG", { title: "a", assigneeId: ann.id });
    assert.equal((await updateIssue(ann, i.ref, { delegate: "remy" })).delegateAgentId, remy);
    assert.equal((await getIssue(ann, i.ref)).issue.delegateAgentId, remy);
    assert.equal((await updateIssue(ann, i.ref, { delegate: null })).delegateAgentId, null);
  });

  test("an admin may delegate someone else's issue; another editor may not", async () => {
    const i = await createIssue(owner, "DG", { title: "b", assigneeId: ann.id });
    await assert.rejects(updateIssue(ed, i.ref, { delegate: "remy" }), code("forbidden"));
    assert.equal((await updateIssue(owner, i.ref, { delegate: "remy" })).delegateAgentId, remy);
  });

  test("an agent off the roster, or an unknown slug, is refused", async () => {
    const i = await createIssue(owner, "DG", { title: "c", assigneeId: ann.id });
    await assert.rejects(updateIssue(ann, i.ref, { delegate: "otto" }), code("invalid"));
    await assert.rejects(updateIssue(ann, i.ref, { delegate: "nobody" }), code("invalid"));
    assert.ok(otto);
  });

  test("an agent cannot delegate, and cannot be the assignee", async () => {
    const i = await createIssue(owner, "DG", { title: "d", assigneeId: ann.id });
    const key: Actor = { kind: "agent", id: crypto.randomUUID(), name: "key", workspaceId: owner.workspaceId, system: true, teamId: team.id };
    await assert.rejects(updateIssue(key, i.ref, { delegate: "remy" }), code("forbidden"));
    await assert.rejects(updateIssue(owner, i.ref, { assigneeId: remy }));
  });

  test("taking the agent off the roster clears it from the team's issues", async () => {
    const i = await createIssue(owner, "DG", { title: "e", assigneeId: ann.id });
    await updateIssue(ann, i.ref, { delegate: "remy" });
    await app.get(AgentsRepository).removeFromRoster(team.id, remy);
    assert.equal((await getIssue(ann, i.ref)).issue.delegateAgentId, null);
  });
});
