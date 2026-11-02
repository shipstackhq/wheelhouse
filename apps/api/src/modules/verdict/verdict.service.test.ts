import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { createIssue } from "../issues/issues.legacy";
import { createTeam } from "../teams/teams.legacy";
import { testApp } from "../../test/app";
import { VerdictService } from "./verdict.service";

const app = await testApp();
const verdicts = app.get(VerdictService);
const RUN = Math.random().toString(16).slice(2, 8);

describe("issueVerdict", () => {
  let owner: Actor;
  let teamId: string;
  let workspaceId: string;
  before(async () => {
    const db = await getDb();
    const [ws] = await db.insert(schema.workspaces).values({ name: "Verdict workspace" }).returning();
    const [u] = await db.insert(schema.users).values({ email: `owner-${RUN}@example.com`, name: "owner", passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: ws.id, role: "owner" });
    owner = { kind: "human", id: u.id, name: "owner", workspaceId: ws.id };
    workspaceId = ws.id;
    teamId = (await createTeam(owner, { name: "Verdict", key: "VD" })).id;
  });

  test("the worst of the issue's open pull requests across repositories; none open is null", async () => {
    const db = await getDb();
    const issue = await createIssue(owner, "VD", { title: "Two repositories" });
    assert.equal(await verdicts.issueVerdict(issue.id), null, "no pull request");
    const pr = async (slug: string, checks: Record<string, { status: string; conclusion: string | null }>, state: "open" | "closed" = "open") => {
      const [repo] = await db.insert(schema.repositories).values({ teamId, workspaceId, displayName: slug, role: "app", provider: "github", slug, githubRepoId: slug, githubFullName: `acme/${slug}`, defaultBranch: "main" }).returning();
      const [p] = await db.insert(schema.pullRequests).values({ repositoryId: repo.id, number: 1, title: "t", url: `https://github.com/acme/${slug}/pull/1`, headSha: "a".repeat(40), checks, state }).returning();
      await db.insert(schema.pullRequestIssues).values({ pullRequestId: p.id, issueId: issue.id });
    };
    await pr("api", { build: { status: "completed", conclusion: "success" } });
    assert.deepEqual(await verdicts.issueVerdict(issue.id), { state: "green", reasons: [] });
    await pr("web", { build: { status: "in_progress", conclusion: null } });
    assert.deepEqual(await verdicts.issueVerdict(issue.id), { state: "pending", reasons: ["CI job build is still running"] });
    await pr("admin", { build: { status: "completed", conclusion: "failure" } });
    assert.deepEqual((await verdicts.issueVerdict(issue.id))?.state, "red");
    await pr("old", { build: { status: "completed", conclusion: "failure" } }, "closed");
    assert.equal((await verdicts.issueVerdict(issue.id))?.reasons.length, 2, "a closed pull request does not count");
  });
});
