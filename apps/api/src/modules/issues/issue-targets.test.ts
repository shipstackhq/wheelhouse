/**
 * Issue targets (WH-129) against a real database: a target is a connected GitHub repository of the issue's team (or a team in its
 * project) and a branch that exists, a sub-issue without targets of its own uses its parent's, and a branch that does not exist is
 * refused when set. GitHub's branch list is stubbed. Runs on an in-memory PGlite, or Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}
Object.assign(process.env, { GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "s", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "w", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "x" });

import { before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { github } from "../github/index";
import { createTeam } from "../teams/teams.legacy";
import { addProjectTeam, createIssue, createProject, getIssue, linkIssueNode, updateIssue, updateProject } from "./issues.legacy";
import { IssueScoping } from "./issue-scoping";
import { testApp } from "../../test/app";
const app = await testApp();

let owner: Actor;
let team: { id: string };
let other: { id: string }; // a second team, outside any project
const repos: Record<string, string> = {};
const code = (c: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === c;
const targetsOf = async (ref: string) => (await getIssue(owner, ref)).targets.map((t) => `${t.repository}@${t.baseBranch}`);
let branchesDown = false;

before(async () => {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: "Targets workspace" }).returning();
  const [u] = await db.insert(schema.users).values({ email: `own-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "owner", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId: w.id, role: "owner" });
  owner = { kind: "human", id: u.id, name: "owner", workspaceId: w.id };
  team = await createTeam(owner, { name: "Targets", key: "TG" });
  other = await createTeam(owner, { name: "Elsewhere", key: "EL" });
  const repo = async (teamId: string, name: string, extra: Partial<typeof schema.repositories.$inferInsert> = {}) => {
    const [r] = await db.insert(schema.repositories).values({ teamId, workspaceId: w.id, displayName: name, role: "x", provider: "github", slug: name, githubRepoId: name, githubInstallationId: "1", githubFullName: `acme/${name}`, defaultBranch: "main", ...extra }).returning();
    repos[name] = r.id;
  };
  await repo(team.id, "web");
  await repo(team.id, "api");
  await repo(team.id, "old", { lifecycle: "retired" });
  await repo(team.id, "local", { provider: "local", githubFullName: null });
  await repo(other.id, "secret");
  github()!.api.branches = async () => {
    if (branchesDown) throw new Error("down");
    return ["main", "development"];
  };
});

describe("issue targets", () => {
  test("set by repository id or owner/name; the branch defaults to the repository's, and the order is kept", async () => {
    const i = await createIssue(owner, "TG", { title: "a", targets: [{ repository: "acme/api" }, { repository: repos.web, branch: "development" }] });
    assert.deepEqual(await targetsOf(i.ref), ["acme/api@main", "acme/web@development"]);
    await updateIssue(owner, i.ref, { targets: [{ repository: "acme/web" }] });
    assert.deepEqual(await targetsOf(i.ref), ["acme/web@main"]);
    await updateIssue(owner, i.ref, { targets: [] });
    assert.deepEqual(await targetsOf(i.ref), []);
  });

  test("a branch that does not exist is refused when set, and so is one GitHub cannot be asked about", async () => {
    const i = await createIssue(owner, "TG", { title: "b" });
    await assert.rejects(updateIssue(owner, i.ref, { targets: [{ repository: "acme/web", branch: "typo" }] }), code("invalid"));
    branchesDown = true;
    await assert.rejects(updateIssue(owner, i.ref, { targets: [{ repository: "acme/web", branch: "development" }] }), code("invalid"));
    branchesDown = false;
    assert.deepEqual(await targetsOf(i.ref), []);
  });

  test("only a connected GitHub repository of the team, once", async () => {
    const i = await createIssue(owner, "TG", { title: "c" });
    for (const repository of ["acme/secret", "acme/old", "acme/local", "acme/nope"]) await assert.rejects(updateIssue(owner, i.ref, { targets: [{ repository }] }), code("invalid"));
    await assert.rejects(updateIssue(owner, i.ref, { targets: [{ repository: "acme/web" }, { repository: repos.web }] }), code("invalid"));
  });

  test("a sub-issue without targets uses its parent's, and its own win", async () => {
    const parent = await createIssue(owner, "TG", { title: "parent", targets: [{ repository: "acme/web", branch: "development" }] });
    const child = await createIssue(owner, "TG", { title: "child", parent: parent.ref });
    const grandchild = await createIssue(owner, "TG", { title: "grandchild", parent: child.ref });
    assert.deepEqual(await targetsOf(grandchild.ref), ["acme/web@development"]);
    assert.equal((await getIssue(owner, grandchild.ref)).inherited, true);
    await updateIssue(owner, child.ref, { targets: [{ repository: "acme/api" }] });
    assert.deepEqual(await targetsOf(grandchild.ref), ["acme/api@main"]);
    assert.equal((await getIssue(owner, child.ref)).inherited, false);
    assert.deepEqual(await targetsOf(parent.ref), ["acme/web@development"]);
  });

  test("a repository of another team in the issue's project can be a target", async () => {
    const p = await createProject(owner, { name: "Shared", leadTeam: "TG" });
    await addProjectTeam(owner, p.id, "EL");
    const i = await createIssue(owner, "TG", { title: "d", projectId: p.id });
    await updateIssue(owner, i.ref, { targets: [{ repository: "acme/secret" }] });
    assert.deepEqual(await targetsOf(i.ref), ["acme/secret@main"]);
  });
});

describe("project repositories and proposals (WH-135)", () => {
  const proposed = async (ref: string) => (await getIssue(owner, ref)).proposedTargets.map((t) => `${t.repository}@${t.baseBranch}`);

  test("a project with one repository settles its issues' targets; with several they are only proposals", async () => {
    const p = await createProject(owner, { name: "Settles", leadTeam: "TG" });
    await updateProject(owner, p.id, { repositories: [{ repository: "acme/web", branch: "development" }] });
    const i = await createIssue(owner, "TG", { title: "in a one-repo project", projectId: p.id });
    assert.deepEqual(await targetsOf(i.ref), ["acme/web@development"]);
    assert.equal((await getIssue(owner, i.ref)).inherited, true);

    await updateProject(owner, p.id, { repositories: [{ repository: "acme/web", branch: "development" }, { repository: "acme/api" }] });
    assert.deepEqual(await targetsOf(i.ref), [], "not settled");
    assert.deepEqual(await proposed(i.ref), ["acme/api@main", "acme/web@development"]);
    await assert.rejects(updateProject(owner, p.id, { repositories: [{ repository: "acme/web", branch: "typo" }] }), code("invalid"));
    await assert.rejects(updateProject(owner, p.id, { repositories: [{ repository: "acme/secret" }] }), code("invalid"), "another team's repository that is not in the project");
  });

  test("a repository named in the issue, or of an earlier run, is proposed", async () => {
    const named = await createIssue(owner, "TG", { title: "Fix the button in acme/web" });
    assert.deepEqual(await proposed(named.ref), ["acme/web@main"]);
    const none = await createIssue(owner, "TG", { title: "Nothing to go on" });
    assert.deepEqual(await proposed(none.ref), []);
    const db = await getDb();
    const [dev] = await db.insert(schema.devices).values({ ownerId: owner.id, name: "box", os: "macos", publicKey: "k" }).returning();
    await db.insert(schema.deviceJobs).values({ teamId: team.id, workspaceId: owner.workspaceId, deviceId: dev.id, issueId: (await getIssue(owner, none.ref)).issue.id, repositoryId: repos.api, model: "m", branch: "b", createdBy: owner.id, offerExpiresAt: new Date() });
    assert.deepEqual(await proposed(none.ref), ["acme/api@main"]);
  });

  test("a proposal is not a target until it is set", async () => {
    const i = await createIssue(owner, "TG", { title: "Look in acme/api" });
    assert.deepEqual(await targetsOf(i.ref), []);
    const [p] = (await getIssue(owner, i.ref)).proposedTargets;
    await updateIssue(owner, i.ref, { targets: [{ repository: p.repositoryId, branch: p.baseBranch }] });
    assert.deepEqual(await targetsOf(i.ref), ["acme/api@main"]);
    assert.deepEqual(await proposed(i.ref), [], "nothing left to propose once it has targets");
  });

  test("the repository of the files a linked map node describes is proposed", async () => {
    const db = await getDb();
    await db.insert(schema.teamFiles).values({ teamId: team.id, workspaceId: owner.workspaceId, path: "packages/ui/button.ts", hash: "h", repositoryId: repos.web });
    await db.insert(schema.nodes).values({ teamId: team.id, workspaceId: owner.workspaceId, name: "Buttons", anchors: ["packages/ui/**", "docs/readme.md#intro"] });
    const i = await createIssue(owner, "TG", { title: "Restyle" });
    await linkIssueNode(owner, i.ref, "Buttons");
    assert.deepEqual(await proposed(i.ref), ["acme/web@main"]);
  });
});

describe("scoping suggestions (WH-136)", () => {
  test("a small model's answer is limited to the team's repositories, and nothing is saved", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const scoping = app.get(IssueScoping);
    const answer = mock.method(scoping, "complete", async () => 'Sure: ["acme/web", "acme/secret", "acme/nope", "acme/web"]');
    try {
      const i = await createIssue(owner, "TG", { title: "Restyle the buttons" });
      const out = await scoping.suggest(owner, i.ref);
      assert.deepEqual(out.suggestions.map((s) => `${s.repository}@${s.baseBranch}`), ["acme/web@main"]);
      assert.match(String(answer.mock.calls[0].arguments[1]), /Restyle the buttons/);
      assert.deepEqual(await targetsOf(i.ref), []);
      answer.mock.mockImplementation(async () => "I cannot tell");
      assert.deepEqual((await scoping.suggest(owner, i.ref)).suggestions, []);
    } finally {
      answer.mock.restore();
    }
  });
});
