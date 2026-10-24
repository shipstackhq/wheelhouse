/**
 * The GitHub integration against a real database (WH-20): what a delivery may touch, what it does, and that one workspace's
 * repository can never reach another workspace. Runs on in-memory PGlite, or real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { createIssue, getIssue, moveIssue } from "../issues/issues";
import { getNode, upsertNode } from "../map/graph";
import { createTeam, deleteTeam, requireTeam } from "../teams/teams";
import { retireRepository } from "./repositories";
import { land } from "../map/sync";
import type { GithubApi } from "./api";
import { connectGithubRepository, GITHUB_ACTOR_ID, handleDelivery, listInstallations, pullRequestsForIssue, registerInstallation, targetsFor } from "./service";

type Workspace = { owner: Actor; member: Actor; installation: string; repoSlug: string; repoRowId: string };
let A: Workspace;
let B: Workspace;

/** A fake GitHub the service talks to. `repos` is what each installation can see; `changed` is what a compare returns. */
const fakeGithub = (() => {
  const state = {
    repos: new Map<string, { id: string; fullName: string; defaultBranch: string; private: boolean }[]>(),
    changed: [] as { path: string; hash: string | null }[],
    compareFails: null as number | null,
    calls: [] as string[],
  };
  const api = {
    installationRepositories: async (inst: string) => state.repos.get(inst) ?? [],
    changedBetween: async (inst: string, repo: string, base: string, head: string) => {
      state.calls.push(`compare ${inst} ${repo} ${base}...${head}`);
      if (state.compareFails) {
        const { GithubApiError } = await import("./api");
        throw new GithubApiError("gone", state.compareFails);
      }
      return state.changed;
    },
    treeAt: async (inst: string, repo: string, sha: string) => {
      state.calls.push(`tree ${inst} ${repo} ${sha}`);
      return { files: state.changed, truncated: false };
    },
  } as unknown as GithubApi;
  return { state, api };
})();

let seed = 0;
const uniq = () => `${Date.now().toString(36)}${(seed++).toString(36)}`;

async function makeWorkspace(name: string, key: string, installation: string, githubRepoId: string): Promise<Workspace> {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name }).returning();
  const mkUser = async (role: "owner" | "member", label: string) => {
    const [u] = await db.insert(schema.users).values({ email: `${label}-${uniq()}@example.com`, name: label, passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: workspace.id, role });
    return { kind: "human", id: u.id, name: label, workspaceId: workspace.id } satisfies Actor;
  };
  const owner = await mkUser("owner", `${name} owner`);
  const member = await mkUser("member", `${name} member`);
  await createTeam(owner, { name: `${name} team`, key });
  fakeGithub.state.repos.set(installation, [{ id: githubRepoId, fullName: `acme/${key.toLowerCase()}-app`, defaultBranch: "main", private: true }]);
  await registerInstallation(owner, { installationId: installation, accountLogin: "acme", accountType: "Organization" });
  const repo = await connectGithubRepository(owner, key, { installationId: installation, githubRepoId, role: "backend" }, fakeGithub.api);
  return { owner, member, installation, repoSlug: repo.slug, repoRowId: repo.id };
}

const SAME_GITHUB_REPO = "424242"; // both workspaces connect "the same" GitHub repository id, each through its own installation

before(async () => {
  A = await makeWorkspace("Alpha", "AA", "9001", SAME_GITHUB_REPO);
  B = await makeWorkspace("Beta", "BB", "9002", SAME_GITHUB_REPO);
});

const push = (installation: string, over: Record<string, unknown> = {}) => ({
  action: undefined,
  ref: "refs/heads/main",
  before: "a".repeat(40),
  after: "b".repeat(40),
  repository: { id: Number(SAME_GITHUB_REPO) },
  installation: { id: Number(installation) },
  ...over,
});
const deliver = (event: string, payload: Record<string, unknown>, id = `d-${uniq()}`) => handleDelivery({ event, deliveryId: id, payload }, fakeGithub.api);

/** An issue in `status`, as if it had been moved there a while ago (a move in the last ten minutes makes pull requests hold back). */
async function issueIn(workspace: Workspace, key: string, title: string, status: string) {
  const t = await createIssue(workspace.owner, key, { title });
  if (status !== "Backlog") await moveIssue(workspace.owner, t.ref, status);
  const db = await getDb();
  await db.update(schema.events).set({ createdAt: new Date(Date.now() - 2 * 3600_000) }).where(and(eq(schema.events.entityId, t.id), eq(schema.events.type, "issue.moved")));
  return t;
}
async function columnOf(workspace: Workspace, ref: string) {
  return (await getIssue(workspace.owner, ref)).issue.status;
}
const prPayload = (workspace: Workspace, action: string, over: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
  action,
  number: 7,
  repository: { id: Number(SAME_GITHUB_REPO) },
  installation: { id: Number(workspace.installation) },
  pull_request: { number: 7, title: "AA-1 something", html_url: "https://github.com/acme/aa-app/pull/7", user: { login: "dev" }, state: "open", merged: false, draft: false, head: { ref: "feature/x", sha: "c".repeat(40) }, ...pr },
  ...over,
});

describe("connecting", () => {
  test("only an owner can register an installation or connect a repository", async () => {
    await assert.rejects(registerInstallation(A.member, { installationId: "5555", accountLogin: "x", accountType: "User" }), /Only workspace owners/);
    await assert.rejects(connectGithubRepository(A.member, "AA", { installationId: A.installation, githubRepoId: SAME_GITHUB_REPO, role: "x" }, fakeGithub.api), /Only workspace owners/);
  });

  test("an installation belongs to one workspace: another workspace cannot register it", async () => {
    await assert.rejects(registerInstallation(B.owner, { installationId: A.installation, accountLogin: "acme", accountType: "Organization" }), /already connected to another workspace/);
    assert.equal((await listInstallations(B.owner)).some((i) => i.installationId === A.installation), false);
  });

  test("a workspace cannot connect a repository through an installation that is not its own", async () => {
    await assert.rejects(connectGithubRepository(B.owner, "BB", { installationId: A.installation, githubRepoId: SAME_GITHUB_REPO, role: "x" }, fakeGithub.api), /not connected to your workspace/);
  });

  test("a repository GitHub does not list for the installation cannot be connected, and the name and branch come from GitHub", async () => {
    await assert.rejects(connectGithubRepository(A.owner, "AA", { installationId: A.installation, githubRepoId: "777", role: "x" }, fakeGithub.api), /does not list that repository/);
    const [row] = await (await getDb()).select().from(schema.repositories).where(eq(schema.repositories.id, A.repoRowId));
    assert.equal(row.githubFullName, "acme/aa-app");
    assert.equal(row.defaultBranch, "main");
    assert.equal(row.provider, "github");
  });

  test("the same repository cannot be connected twice to a team, and connecting needs the App to be configured", async () => {
    await assert.rejects(connectGithubRepository(A.owner, "AA", { installationId: A.installation, githubRepoId: SAME_GITHUB_REPO, role: "x" }, fakeGithub.api), /already connected/);
    await assert.rejects(connectGithubRepository(A.owner, "AA", { installationId: A.installation, githubRepoId: SAME_GITHUB_REPO, role: "x" }, null), /not configured/);
  });
});

describe("who a webhook can reach", () => {
  test("it resolves through the installation and repository id to exactly the workspace that owns that installation", async () => {
    const a = await targetsFor(A.installation, SAME_GITHUB_REPO);
    const b = await targetsFor(B.installation, SAME_GITHUB_REPO);
    assert.deepEqual(a.map((t) => t.team.key), ["AA"]);
    assert.deepEqual(b.map((t) => t.team.key), ["BB"]);
  });

  test("an unknown installation or repository reaches nothing", async () => {
    assert.deepEqual(await targetsFor("1", SAME_GITHUB_REPO), []);
    assert.deepEqual(await targetsFor(A.installation, "1"), []);
  });

  test("a repository row that claims another workspace's installation is never reached, even if someone forged it", async () => {
    const db = await getDb();
    // Workspace B's team gets a row pointing at WORKSPACE A's installation, as an owner editing the fields by hand could try.
    const [forged] = await db
      .insert(schema.repositories)
      .values({ teamId: (await requireTeam(B.owner, "BB")).id, workspaceId: B.owner.workspaceId, displayName: "forged", role: "x", provider: "github", slug: `forged-${uniq()}`, githubRepoId: "31337", githubInstallationId: A.installation })
      .returning();
    assert.deepEqual(await targetsFor(A.installation, "31337"), [], "the join on the installation's owning workspace excludes it");
    await db.delete(schema.repositories).where(eq(schema.repositories.id, forged.id));
  });

  test("a retired repository stops receiving", async () => {
    const db = await getDb();
    const extra = await (async () => {
      fakeGithub.state.repos.set(A.installation, [...(fakeGithub.state.repos.get(A.installation) ?? []), { id: "5150", fullName: "acme/old", defaultBranch: "main", private: false }]);
      return connectGithubRepository(A.owner, "AA", { installationId: A.installation, githubRepoId: "5150", role: "old" }, fakeGithub.api);
    })();
    assert.equal((await targetsFor(A.installation, "5150")).length, 1);
    await retireRepository(A.owner, "AA", extra.id);
    assert.equal((await targetsFor(A.installation, "5150")).length, 0);
    await db.delete(schema.repositories).where(eq(schema.repositories.id, extra.id));
  });
});

describe("pushes", () => {
  async function describedNode(workspace: Workspace, key: string, name: string, file: string, hash: string) {
    await land(workspace.owner, key, { baseline: true, files: { [file]: hash }, repository: workspace.repoSlug });
    await upsertNode(workspace.owner, key, { name, layer: "code", kind: "file", anchors: [file], describedHashes: { [file]: hash }, markFresh: true, summary: name });
  }
  const nodeOf = async (workspace: Workspace, key: string, name: string) => (await getNode(workspace.owner, key, name)).node;

  test("a push to the default branch lands the changed files and flags the node whose code changed, with no plugin involved", async () => {
    await describedNode(A, "AA", "Core", "src/core.ts", "hash-1");
    assert.equal((await nodeOf(A, "AA", "Core")).stale, false);
    fakeGithub.state.changed = [{ path: "src/core.ts", hash: "hash-2" }];
    const r = await deliver("push", push(A.installation));
    assert.equal(r.status, "handled");
    assert.equal(r.matched, 1);
    const n = await nodeOf(A, "AA", "Core");
    assert.equal(n.stale, true);
    assert.deepEqual(n.driftPaths, ["src/core.ts"]);
    const [ev] = (await (await getDb()).select().from(schema.events).where(and(eq(schema.events.type, "code.landed"), eq(schema.events.actorName, "GitHub")))).slice(-1);
    assert.equal(ev.actorId, GITHUB_ACTOR_ID);
  });

  test("the same push for another workspace's installation does not touch this workspace's map", async () => {
    await describedNode(B, "BB", "Core", "src/core.ts", "hash-1");
    fakeGithub.state.changed = [{ path: "src/core.ts", hash: "hash-9" }];
    await deliver("push", push(A.installation));
    assert.equal((await nodeOf(B, "BB", "Core")).stale, false, "workspace B's node is untouched by workspace A's push");
    await deliver("push", push(B.installation));
    assert.equal((await nodeOf(B, "BB", "Core")).stale, true, "and does react to its own installation's push");
  });

  test("a push to another branch, a deleted branch and a tag are ignored without asking GitHub anything", async () => {
    fakeGithub.state.calls.length = 0;
    for (const over of [{ ref: "refs/heads/feature" }, { ref: "refs/tags/v1" }, { deleted: true }]) {
      const r = await deliver("push", push(A.installation, over));
      assert.equal(r.status, "ignored", JSON.stringify(over));
    }
    assert.deepEqual(fakeGithub.state.calls, []);
  });

  test("a first push (no previous commit) and a push whose old commit is gone both fall back to the whole tree", async () => {
    fakeGithub.state.calls.length = 0;
    fakeGithub.state.changed = [{ path: "src/core.ts", hash: "hash-3" }];
    await deliver("push", push(A.installation, { before: "0".repeat(40) }));
    assert.match(fakeGithub.state.calls[0], /^tree /);
    fakeGithub.state.calls.length = 0;
    fakeGithub.state.compareFails = 404;
    await deliver("push", push(A.installation, { before: "d".repeat(40) }));
    fakeGithub.state.compareFails = null;
    assert.match(fakeGithub.state.calls.join("|"), /^compare .*\|tree /);
  });

  test("a redelivery of the same push changes nothing", async () => {
    fakeGithub.state.changed = [{ path: "src/core.ts", hash: "hash-4" }];
    const id = `dup-${uniq()}`;
    const first = await deliver("push", push(A.installation), id);
    const landedBefore = (await (await getDb()).select().from(schema.events).where(eq(schema.events.type, "code.landed"))).length;
    const again = await deliver("push", push(A.installation), id);
    assert.equal(first.status, "handled");
    assert.equal(again.status, "duplicate");
    assert.equal((await (await getDb()).select().from(schema.events).where(eq(schema.events.type, "code.landed"))).length, landedBefore);
  });

  test("a delivery that fails is not remembered, so GitHub's retry gets processed", async () => {
    const id = `fail-${uniq()}`;
    fakeGithub.state.compareFails = 500;
    await assert.rejects(deliver("push", push(A.installation), id));
    fakeGithub.state.compareFails = null;
    fakeGithub.state.changed = [{ path: "src/core.ts", hash: "hash-5" }];
    assert.equal((await deliver("push", push(A.installation), id)).status, "handled");
  });
});

describe("pull requests", () => {
  test("opening one for AA-1 moves the issue to Review and says so on the issue", async () => {
    const t = await issueIn(A, "AA", "Pull request target", "In Progress");
    const num = t.ref.split("-")[1];
    const r = await deliver("pull_request", prPayload(A, "opened", {}, { title: `AA-${num} do it`, number: 11 }));
    assert.equal(r.status, "handled");
    assert.equal(await columnOf(A, t.ref), "Review");
    const detail = await getIssue(A.owner, t.ref);
    assert.ok(detail.comments.some((c) => c.authorName === "GitHub" && /moved to Review: pull request opened/.test(c.body)));
    assert.ok(detail.history.some((e) => e.type === "issue.pull_request"));
    const prs = await pullRequestsForIssue(t.id);
    assert.equal(prs.length, 1);
    assert.equal(prs[0].number, 11);
    assert.equal(detail.pullRequests.length, 1, "getIssue carries them for the issue view and agents");
  });

  test("the branch name links an issue too, and another team's key in the same title does not", async () => {
    const t = await issueIn(A, "AA", "Linked by branch", "Todo");
    const num = t.ref.split("-")[1];
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 12, title: "Unrelated words BB-1 and API-9", head: { ref: `feature/aa-${num}-by-branch`, sha: "e".repeat(40) } }));
    assert.equal(await columnOf(A, t.ref), "Review");
    assert.equal((await pullRequestsForIssue(t.id)).length, 1);
  });

  test("a draft does not move anything until it is ready", async () => {
    const t = await issueIn(A, "AA", "Draft work", "In Progress");
    const num = t.ref.split("-")[1];
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 13, draft: true, title: `AA-${num} wip` }));
    assert.equal(await columnOf(A, t.ref), "In Progress");
    await deliver("pull_request", prPayload(A, "ready_for_review", {}, { number: 13, draft: false, title: `AA-${num} wip` }));
    assert.equal(await columnOf(A, t.ref), "Review");
  });

  test("closed without merging puts an issue in Review back to In Progress, with a comment", async () => {
    const t = await issueIn(A, "AA", "Abandoned", "In Progress");
    const num = t.ref.split("-")[1];
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 14, title: `AA-${num} x` }));
    assert.equal(await columnOf(A, t.ref), "Review");
    // The issue moved a moment ago (by GitHub itself), which must not count as "someone else moved it".
    await deliver("pull_request", prPayload(A, "closed", {}, { number: 14, title: `AA-${num} x`, state: "closed", merged: false }));
    assert.equal(await columnOf(A, t.ref), "In Progress");
    assert.ok((await getIssue(A.owner, t.ref)).comments.some((c) => /closed without merging/.test(c.body)));
  });

  test("merged leaves an issue in Review for a person to close", async () => {
    const t = await issueIn(A, "AA", "Merged work", "In Progress");
    const num = t.ref.split("-")[1];
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 15, title: `AA-${num} y` }));
    await deliver("pull_request", prPayload(A, "closed", {}, { number: 15, title: `AA-${num} y`, state: "closed", merged: true }));
    assert.equal(await columnOf(A, t.ref), "Review");
    const prs = await pullRequestsForIssue(t.id);
    assert.equal(prs[0].state, "merged");
  });

  test("a person or agent who moved the issue a moment ago is not overruled, and the comment says so", async () => {
    const t = await issueIn(A, "AA", "Just moved", "Todo");
    const num = t.ref.split("-")[1];
    await moveIssue(A.owner, t.ref, "In Progress"); // by a person, seconds ago
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 16, title: `AA-${num} z` }));
    assert.equal(await columnOf(A, t.ref), "In Progress");
    assert.ok((await getIssue(A.owner, t.ref)).comments.some((c) => c.authorName === "GitHub" && /moved it 1 minute ago, so the pull request \(opened\) did not move it/.test(c.body)));
  });

  test("an issue in Done is never moved", async () => {
    const t = await issueIn(A, "AA", "Already done", "Done");
    const num = t.ref.split("-")[1];
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 17, title: `AA-${num} done` }));
    assert.equal(await columnOf(A, t.ref), "Done");
  });

  test("a pull request on workspace A's repository never touches workspace B's issues, even with a matching ref", async () => {
    const t = await issueIn(B, "BB", "Workspace B issue", "In Progress");
    const num = t.ref.split("-")[1];
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 18, title: `BB-${num} sneaky` }));
    assert.equal(await columnOf(B, t.ref), "In Progress");
    assert.equal((await pullRequestsForIssue(t.id)).length, 0);
  });

  test("a pull request from a repository nobody connected reaches nothing", async () => {
    const r = await deliver("pull_request", prPayload(A, "opened", { repository: { id: 999 } }));
    assert.equal(r.status, "ignored");
  });
});

describe("checks", () => {
  const runPayload = (workspace: Workspace, name: string, status: string, conclusion: string | null, sha: string, number: number) => ({
    action: "completed",
    repository: { id: Number(SAME_GITHUB_REPO) },
    installation: { id: Number(workspace.installation) },
    check_run: { name, status, conclusion, head_sha: sha, html_url: `https://ci.example/${name}`, pull_requests: [{ number }] },
  });

  test("a failing check is recorded, flagged with an event and a comment, and a later pass clears it", async () => {
    const t = await issueIn(A, "AA", "Has CI", "In Progress");
    const num = t.ref.split("-")[1];
    const sha = "f".repeat(40);
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 21, title: `AA-${num} ci`, head: { ref: "ci", sha } }));
    await deliver("check_run", runPayload(A, "build", "in_progress", null, sha, 21));
    assert.equal((await pullRequestsForIssue(t.id))[0].ciState, "pending");
    await deliver("check_run", runPayload(A, "tests", "completed", "failure", sha, 21));
    let d = await getIssue(A.owner, t.ref);
    assert.equal(d.pullRequests[0].ciState, "failure");
    assert.ok(d.history.some((e) => e.type === "issue.ci" && /CI failed/.test(e.summary)));
    assert.ok(d.comments.some((c) => /CI failed on pull request/.test(c.body) && /tests/.test(c.body)));
    await deliver("check_run", runPayload(A, "tests", "completed", "success", sha, 21));
    await deliver("check_run", runPayload(A, "build", "completed", "success", sha, 21));
    d = await getIssue(A.owner, t.ref);
    assert.equal(d.pullRequests[0].ciState, "success");
  });

  test("a result for an older commit is ignored, and a new commit starts a new round", async () => {
    const t = await issueIn(A, "AA", "New commit", "In Progress");
    const num = t.ref.split("-")[1];
    const first = "1".repeat(40), second = "2".repeat(40);
    await deliver("pull_request", prPayload(A, "opened", {}, { number: 22, title: `AA-${num} c`, head: { ref: "c", sha: first } }));
    await deliver("check_run", runPayload(A, "tests", "completed", "failure", first, 22));
    assert.equal((await pullRequestsForIssue(t.id))[0].ciState, "failure");
    await deliver("pull_request", prPayload(A, "synchronize", {}, { number: 22, title: `AA-${num} c`, head: { ref: "c", sha: second } }));
    assert.equal((await pullRequestsForIssue(t.id))[0].ciState, null, "the old commit's failure no longer counts");
    await deliver("check_run", runPayload(A, "tests", "completed", "failure", first, 22)); // a late result for the old commit
    assert.equal((await pullRequestsForIssue(t.id))[0].ciState, null);
  });

  test("a check on workspace A's repository never changes a pull request of workspace B", async () => {
    const t = await issueIn(B, "BB", "B has CI", "In Progress");
    const num = t.ref.split("-")[1];
    const sha = "9".repeat(40);
    await deliver("pull_request", prPayload(B, "opened", {}, { number: 23, title: `BB-${num} ci`, head: { ref: "b", sha } }));
    await deliver("check_run", runPayload(A, "tests", "completed", "failure", sha, 23));
    assert.equal((await pullRequestsForIssue(t.id))[0].ciState, null);
  });
});

describe("other events", () => {
  test("a ping is answered and an event we do not use is ignored", async () => {
    assert.equal((await deliver("ping", { zen: "x" })).status, "handled");
    assert.equal((await deliver("star", { action: "created" })).status, "ignored");
  });

  test("removing the App ends the connection: later pushes reach nothing", async () => {
    const workspace = await makeWorkspace("Gamma", "GG", "9003", "808080");
    assert.equal((await targetsFor("9003", "808080")).length, 1);
    const r = await deliver("installation", { action: "deleted", installation: { id: 9003 } });
    assert.equal(r.status, "handled");
    assert.equal((await targetsFor("9003", "808080")).length, 0);
    assert.equal((await listInstallations(workspace.owner)).length, 0);
  });

  test("deleting a team removes its pull requests along with it", async () => {
    const db = await getDb();
    const workspace = await makeWorkspace("Delta", "DD", "9004", "909090");
    const t = await issueIn(workspace, "DD", "Doomed", "In Progress");
    const num = t.ref.split("-")[1];
    await handleDelivery({ event: "pull_request", deliveryId: `d-${uniq()}`, payload: { action: "opened", repository: { id: 909090 }, installation: { id: 9004 }, pull_request: { number: 1, title: `DD-${num} x`, html_url: "u", user: { login: "d" }, state: "open", head: { ref: "x", sha: "7".repeat(40) } } } }, fakeGithub.api);
    assert.equal((await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.repositoryId, workspace.repoRowId))).length, 1);
    await createTeam(workspace.owner, { name: "Keep", key: "DK" }); // the last active team of a workspace cannot be deleted
    await deleteTeam(workspace.owner, "DD");
    assert.equal((await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.repositoryId, workspace.repoRowId))).length, 0);
  });
});
