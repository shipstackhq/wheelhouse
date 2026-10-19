import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DOC_TEMPLATES } from "../../packages/core/src/lib/doc-templates";
import { fx, v1ok } from "./lib/http";
import { LANDED_FILE } from "./lib/fake-github";
import { anon, app, newAccount, signIn, type Sess } from "./lib/app";

/**
 * The docs, repositories, Connect GitHub and onboarding endpoints (WH-98). Everything that changes data does it in a workspace made for
 * the test, except the GitHub connection, which needs the installation the seed gave workspace A (a fake GitHub answers for it).
 */
const gh = fx.github!;

async function workspace(name = "Docs") {
  const owner = await newAccount(name);
  const project = (await app("POST", "/api/app/projects", owner.sess, { body: { name: `${name} project`, key: "DOC" } })).json.project;
  const key = (await app("POST", "/api/app/keys", owner.sess, { body: { name: "agent" } })).json.secret as string;
  return { owner, key, project, s: owner.sess };
}

const docs = (s: Sess, key = "DOC") => app("GET", `/api/app/projects/${key}/docs`, s);
const create = async (s: Sess, body: Record<string, unknown>, key = "DOC") => {
  const r = await app("POST", `/api/app/projects/${key}/docs`, s, { body });
  assert.equal(r.status, 201, r.text);
  return r.json.doc as { id: string; version: number; title: string; body: string; slug: string; stale: boolean; anchors: string[]; parentId: string | null };
};
const patch = (s: Sess, id: string, body: Record<string, unknown>, key = "DOC") => app("PATCH", `/api/app/projects/${key}/docs/${id}`, s, { body });

describe("docs", () => {
  test("signed out is a 401, and a forged request is refused", async () => {
    assert.equal((await app("GET", "/api/app/projects/DOC/docs", anon())).status, 401);
    const t = await workspace();
    assert.equal((await app("POST", "/api/app/projects/DOC/docs", t.s, { body: { title: "x" }, origin: "https://evil.example" })).status, 403);
    assert.equal((await app("POST", "/api/app/projects/DOC/docs", t.s, { body: { title: "x" }, csrf: null })).status, 403);
    assert.equal((await docs(t.s)).json.docs.length, 0);
  });

  test("a new doc, blank or from each of the five templates; a template fills the body unless one is given", async () => {
    const t = await workspace();
    const blank = await create(t.s, { title: "Plain" });
    assert.deepEqual([blank.body, blank.version, blank.slug, blank.stale, blank.parentId], ["", 1, "plain", false, null]);
    assert.equal(DOC_TEMPLATES.length, 5);
    for (const tpl of DOC_TEMPLATES) {
      const d = await create(t.s, { title: tpl.name, template: tpl.id });
      assert.equal(d.body, tpl.body, tpl.id);
    }
    assert.equal((await create(t.s, { title: "Own words", template: "spec", body: "mine" })).body, "mine");
    assert.equal((await docs(t.s)).json.docs.length, 7);
  });

  test("problems arrive by field, and nothing is created", async () => {
    const t = await workspace();
    for (const [body, field] of [[{}, "title"], [{ title: "  " }, "title"], [{ title: 5 }, "title"], [{ title: "x", template: "nope" }, "template"], [{ title: "x", body: 5 }, "body"], [{ title: "x", parent: 5 }, "parent"]] as const) {
      const r = await app("POST", "/api/app/projects/DOC/docs", t.s, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field], `${JSON.stringify(body)} → ${field}`);
    }
    assert.equal((await docs(t.s)).json.docs.length, 0);
  });

  test("the index is the tree and what the page's panels offer, all from this workspace", async () => {
    const t = await workspace();
    const parent = await create(t.s, { title: "Parent" });
    const child = await create(t.s, { title: "Child", parent: parent.id });
    assert.equal(child.parentId, parent.id);
    await app("PUT", "/api/app/projects/DOC/nodes", t.s, { body: { name: "Gateway", layer: "system" } });
    await app("PUT", "/api/app/projects/DOC/decisions", t.s, { body: { title: "Use REST" } });
    const r = await docs(t.s);
    assert.deepEqual(r.json.docs.map((d: { title: string }) => d.title).sort(), ["Child", "Parent"]);
    assert.deepEqual(Object.keys(r.json.docs[0]).sort(), ["id", "parentId", "position", "slug", "stale", "title", "updatedAt", "version"]);
    assert.deepEqual(r.json.nodes.map((n: { name: string }) => n.name), ["Gateway"]);
    assert.deepEqual(r.json.decisions.map((d: { title: string }) => d.title), ["Use REST"]);
    assert.deepEqual(r.json.members.map((m: { id: string }) => m.id), [t.owner.me.user.id]);
  });

  test("one doc by id or slug, with the map nodes it is linked to and none of the internal columns", async () => {
    const t = await workspace();
    const d = await create(t.s, { title: "Arch", body: "Hello" });
    const r = await app("GET", `/api/app/projects/DOC/docs/${d.id}`, t.s);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.doc.body, r.json.doc.version, r.json.doc.updatedByKind, r.json.nodes], ["Hello", 1, "human", []]);
    assert.equal(r.json.doc.describedHashes, undefined, "internal columns are not sent");
    assert.equal((await app("GET", `/api/app/projects/DOC/docs/${d.slug}`, t.s)).status, 200, "a slug works too");
    assert.equal((await app("GET", "/api/app/projects/DOC/docs/00000000-0000-4000-8000-000000000000", t.s)).status, 404);
  });

  test("edit: only what is sent changes, the version moves on, and a stale version is a 409 that returns the doc as it is now and changes nothing", async () => {
    const t = await workspace();
    const d = await create(t.s, { title: "Plan", body: "v1" });
    const ok = await patch(t.s, d.id, { body: "v2", version: 1 });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.doc.body, ok.json.doc.title, ok.json.doc.version], ["v2", "Plan", 2]);
    const stale = await patch(t.s, d.id, { body: "mine", version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "conflict");
    assert.match(stale.json.error.message, /was changed \(version 2, you had 1\)/);
    assert.deepEqual([stale.json.error.details.current.body, stale.json.error.details.current.version], ["v2", 2]);
    assert.equal(stale.json.error.details.current.describedHashes, undefined);
    assert.equal((await app("GET", `/api/app/projects/DOC/docs/${d.id}`, t.s)).json.doc.body, "v2");
    const renamed = await patch(t.s, d.id, { title: "Plan B", version: 2 });
    assert.deepEqual([renamed.json.doc.title, renamed.json.doc.body], ["Plan B", "v2"]);
  });

  test("two edits from the same version: exactly one wins", async () => {
    const t = await workspace();
    const d = await create(t.s, { title: "Race", body: "start" });
    const rs = await Promise.all([patch(t.s, d.id, { body: "A", version: 1 }), patch(t.s, d.id, { body: "B", version: 1 })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  });

  test("edit problems arrive by field", async () => {
    const t = await workspace();
    const d = await create(t.s, { title: "Strict" });
    for (const [body, field] of [[{ title: "" }, "title"], [{ title: 5 }, "title"], [{ body: 5 }, "body"], [{ anchors: "a" }, "anchors"], [{ anchors: [1] }, "anchors"], [{ version: "1" }, "version"]] as const) {
      const r = await patch(t.s, d.id, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field], `${JSON.stringify(body)} → ${field}`);
    }
    const big = await patch(t.s, d.id, { body: "x".repeat(200 * 1024 + 1) });
    assert.equal(big.status, 400);
    assert.match(big.json.error.message, /200 KB/);
  });

  test("anchors: saved trimmed; a change to anchored code flags the doc; editing or 'still accurate' clears it", async () => {
    const t = await workspace();
    const d = await create(t.s, { title: "Pay docs", body: "How `src/pay/charge.ts` works" });
    const saved = await patch(t.s, d.id, { anchors: [" src/pay/** ", "", "README.md"], version: 1 });
    assert.deepEqual(saved.json.doc.anchors, ["src/pay/**", "README.md"]);
    await v1ok({ key: t.key }, "report_changes", { project: "DOC", files: ["src/pay/charge.ts"], summary: "changed" });
    const flagged = (await app("GET", `/api/app/projects/DOC/docs/${d.id}`, t.s)).json.doc;
    assert.equal(flagged.stale, true);
    assert.ok(flagged.staleReason);
    assert.equal((await docs(t.s)).json.docs[0].stale, true);
    const fresh = await app("POST", `/api/app/projects/DOC/docs/${d.id}/fresh`, t.s, { body: {} });
    assert.equal(fresh.status, 200);
    assert.deepEqual([fresh.json.doc.stale, fresh.json.doc.staleReason], [false, null]);
    await v1ok({ key: t.key }, "report_changes", { project: "DOC", files: ["src/pay/charge.ts"], summary: "again" });
    assert.equal((await app("GET", `/api/app/projects/DOC/docs/${d.id}`, t.s)).json.doc.stale, true);
    const edited = await patch(t.s, d.id, { body: "rewritten", version: fresh.json.doc.version });
    assert.equal(edited.json.doc.stale, false);
  });

  test("suggested anchors: the paths the text mentions and the anchors of the nodes it is linked to", async () => {
    const t = await workspace();
    const node = (await app("PUT", "/api/app/projects/DOC/nodes", t.s, { body: { name: "Billing", layer: "system", anchors: ["apps/billing/**"] } })).json.node;
    const d = await create(t.s, { title: "Billing", body: "See `src/lib/pay.ts` and apps/web/index.html." });
    assert.equal((await app("PUT", `/api/app/projects/DOC/docs/${d.id}/nodes/${node.id}`, t.s, { body: {} })).status, 200);
    const r = await app("GET", `/api/app/projects/DOC/docs/${d.id}/anchor-suggestions`, t.s);
    assert.equal(r.status, 200);
    for (const a of ["src/lib/pay.ts", "apps/web/index.html", "apps/billing/**"]) assert.ok(r.json.anchors.includes(a), a);
  });

  test("move: under another doc and back to the top; a doc cannot go under itself or its own child; a stale version is a 409", async () => {
    const t = await workspace();
    const a = await create(t.s, { title: "A" });
    const b = await create(t.s, { title: "B" });
    const move = (id: string, body: Record<string, unknown>) => app("POST", `/api/app/projects/DOC/docs/${id}/move`, t.s, { body });
    assert.equal((await move(b.id, { parent: a.id })).json.doc.parentId, a.id);
    assert.equal((await move(b.id, { parent: null })).json.doc.parentId, null);
    await move(b.id, { parent: a.id });
    assert.equal((await move(a.id, { parent: a.id })).status, 400);
    const cycle = await move(a.id, { parent: b.id });
    assert.equal(cycle.status, 400);
    assert.match(cycle.json.error.message, /descendants/);
    const stale = await move(a.id, { parent: null, version: 99 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.details.current.id, a.id);
  });

  test("delete takes the nested docs with it", async () => {
    const t = await workspace();
    const a = await create(t.s, { title: "A" });
    const b = await create(t.s, { title: "B", parent: a.id });
    assert.equal((await app("DELETE", `/api/app/projects/DOC/docs/${a.id}`, t.s)).status, 200);
    assert.equal((await docs(t.s)).json.docs.length, 0);
    assert.equal((await app("GET", `/api/app/projects/DOC/docs/${b.id}`, t.s)).status, 404);
  });

  test("link a doc to map nodes and unlink it", async () => {
    const t = await workspace();
    const node = (await app("PUT", "/api/app/projects/DOC/nodes", t.s, { body: { name: "Gateway", layer: "system" } })).json.node;
    const d = await create(t.s, { title: "Gateway notes" });
    assert.equal((await app("PUT", `/api/app/projects/DOC/docs/${d.id}/nodes/${node.id}`, t.s, { body: {} })).status, 200);
    assert.equal((await app("PUT", `/api/app/projects/DOC/docs/${d.id}/nodes/${node.id}`, t.s, { body: {} })).status, 200, "linking twice is harmless");
    assert.deepEqual((await app("GET", `/api/app/projects/DOC/docs/${d.id}`, t.s)).json.nodes.map((n: { name: string }) => n.name), ["Gateway"]);
    assert.equal((await app("DELETE", `/api/app/projects/DOC/docs/${d.id}/nodes/${node.id}`, t.s)).status, 200);
    assert.deepEqual((await app("GET", `/api/app/projects/DOC/docs/${d.id}`, t.s)).json.nodes, []);
  });

  test("an action item becomes a ticket through the ordinary ticket endpoint", async () => {
    const t = await workspace();
    const r = await app("POST", "/api/app/projects/DOC/tickets", t.s, { body: { title: "Write the runbook" } });
    assert.equal(r.status, 201);
    assert.equal(r.json.ticket.title, "Write the runbook");
  });

  test("another workspace's projects, docs and nodes are a 404 on every route, and change nothing", async () => {
    const mine = await workspace("Mine");
    const theirs = await workspace("Theirs");
    const secret = await create(theirs.s, { title: "Their plan", body: "secret" });
    const node = (await app("PUT", "/api/app/projects/DOC/nodes", theirs.s, { body: { name: "Their node", layer: "system" } })).json.node;
    const own = await create(mine.s, { title: "Mine" });
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/app/projects/DOC/docs/${secret.id}`],
      ["PATCH", `/api/app/projects/DOC/docs/${secret.id}`, { body: "hijacked" }],
      ["POST", `/api/app/projects/DOC/docs/${secret.id}/fresh`, {}],
      ["GET", `/api/app/projects/DOC/docs/${secret.id}/anchor-suggestions`],
      ["POST", `/api/app/projects/DOC/docs/${secret.id}/move`, { parent: null }],
      ["DELETE", `/api/app/projects/DOC/docs/${secret.id}`],
      ["PUT", `/api/app/projects/DOC/docs/${secret.id}/nodes/${node.id}`, {}],
      ["PUT", `/api/app/projects/DOC/docs/${own.id}/nodes/${node.id}`, {}],
      ["POST", `/api/app/projects/DOC/docs`, { title: "x", parent: secret.id }],
      ["POST", `/api/app/projects/DOC/docs/${own.id}/move`, { parent: secret.id }],
    ];
    for (const [method, path, body] of calls) {
      const r = await app(method, path, mine.s, { body });
      assert.equal(r.status, 404, `${method} ${path}: ${r.status} ${r.text.slice(0, 120)}`);
      assert.ok(!r.text.includes("secret"), `${method} ${path} leaked`);
    }
    assert.equal((await app("GET", "/api/app/projects/NOPE/docs", mine.s)).status, 404);
    const theirDoc = (await app("GET", `/api/app/projects/DOC/docs/${secret.id}`, theirs.s)).json.doc;
    assert.deepEqual([theirDoc.body, theirDoc.version], ["secret", 1]);
    assert.deepEqual((await docs(mine.s)).json.docs.map((d: { title: string }) => d.title), ["Mine"]);
  });

  test("an agent key without docs:write cannot write a doc, but the web person can", async () => {
    const t = await workspace();
    const denied = await fetchV1(t.key, "upsert_doc", { project: "DOC", title: "From agent" });
    assert.equal(denied, 403);
    assert.equal((await create(t.s, { title: "From a person" })).title, "From a person");
  });
});

async function fetchV1(key: string, tool: string, args: Record<string, unknown>) {
  const { call } = await import("./lib/http");
  return (await call(`/api/v1/${tool}`, { key, method: "POST", body: args })).status;
}

describe("repositories", () => {
  const repos = (s: Sess, key = "DOC") => app("GET", `/api/app/projects/${key}/repositories`, s);

  test("link one by hand, change it, retire it; the answer is a view without installation ids", async () => {
    const t = await workspace();
    const made = await app("POST", "/api/app/projects/DOC/repositories", t.s, { body: { displayName: "Backend", role: "backend", defaultBranch: "trunk", pathLimit: "packages/api/" } });
    assert.equal(made.status, 201, made.text);
    const r = made.json.repository;
    assert.deepEqual([r.displayName, r.role, r.provider, r.defaultBranch, r.pathLimit, r.lifecycle, r.lastEventAt, r.browsable], ["Backend", "backend", "local", "trunk", "packages/api/", "live", null, false]);
    assert.equal(r.githubInstallationId, undefined);
    assert.equal(r.githubRepoId, undefined);
    const updated = await app("PATCH", `/api/app/projects/DOC/repositories/${r.id}`, t.s, { body: { role: "api", pathLimit: null, lifecycle: "being_replaced" } });
    assert.deepEqual([updated.json.repository.role, updated.json.repository.pathLimit, updated.json.repository.lifecycle, updated.json.repository.displayName], ["api", null, "being_replaced", "Backend"]);
    const retired = await app("POST", `/api/app/projects/DOC/repositories/${r.id}/retire`, t.s, { body: {} });
    assert.equal(retired.json.repository.lifecycle, "retired");
    assert.deepEqual((await repos(t.s)).json.repositories.map((x: { lifecycle: string }) => x.lifecycle), ["retired"]);
  });

  test("a repository adds a service node to the map", async () => {
    const t = await workspace();
    await app("POST", "/api/app/projects/DOC/repositories", t.s, { body: { displayName: "Mobile", role: "ios" } });
    const g = (await app("GET", "/api/app/projects/DOC/graph", t.s)).json;
    assert.ok(g.nodes.some((n: { name: string; layer: string }) => n.name === "Mobile" && n.layer === "system"));
  });

  test("problems arrive by field, and nothing is created", async () => {
    const t = await workspace();
    for (const [body, field] of [[{ role: "x" }, "displayName"], [{ displayName: "x" }, "role"], [{ displayName: " ", role: "x" }, "displayName"], [{ displayName: "x", role: "y", provider: "svn" }, "provider"], [{ displayName: "x", role: "y", lifecycle: "dead" }, "lifecycle"], [{ displayName: "x", role: "y", pathLimit: 5 }, "pathLimit"]] as const) {
      const r = await app("POST", "/api/app/projects/DOC/repositories", t.s, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field], `${JSON.stringify(body)} → ${field}`);
    }
    assert.equal((await repos(t.s)).json.repositories.length, 0);
  });

  test("another workspace's repositories are a 404 and are never listed", async () => {
    const mine = await workspace("Mine");
    const theirs = await workspace("Theirs");
    const r = (await app("POST", "/api/app/projects/DOC/repositories", theirs.s, { body: { displayName: "Secret", role: "x" } })).json.repository;
    for (const [method, path, body] of [
      ["PATCH", `/api/app/projects/DOC/repositories/${r.id}`, { role: "hijacked" }],
      ["POST", `/api/app/projects/DOC/repositories/${r.id}/retire`, {}],
      ["GET", `/api/app/projects/DOC/repositories/${r.id}/tree`],
    ] as const) {
      assert.equal((await app(method, path, mine.s, { body })).status, 404, `${method} ${path}`);
    }
    assert.equal((await repos(mine.s)).json.repositories.length, 0);
    assert.equal((await repos(theirs.s)).json.repositories[0].role, "x");
    assert.equal((await app("GET", "/api/app/projects/NOPE/repositories", mine.s)).status, 404);
  });
});

describe("Connect GitHub", () => {
  /** A project of the "connect" workspace, which owns one installation (with one repository only it can see) and no repositories yet. */
  async function fresh() {
    const owner = await signIn(fx.connect.email);
    const key = `G${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const r = await app("POST", "/api/app/projects", owner, { body: { name: `Connect ${key}`, key } });
    assert.equal(r.status, 201, r.text);
    return { owner, key };
  }
  const status = (s: Sess, key: string) => app("GET", `/api/app/projects/${key}/repositories/github`, s);
  const connect = (s: Sess, key: string, body: Record<string, unknown>) => app("POST", `/api/app/projects/${key}/repositories/github`, s, { body });
  const own = { installationId: gh.installationC, repoId: gh.connectRepoId };

  test("an owner sees the workspace's installations and the repositories this project could still connect; a member sees nothing of them", async () => {
    const { owner, key } = await fresh();
    const r = await status(owner, key);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.configured, r.json.isOwner, r.json.missing], [true, true, []]);
    assert.deepEqual(r.json.installations, [{ installationId: gh.installationC, account: "contract-connect", failed: false, repositories: [{ id: gh.connectRepoId, fullName: "ct/connect-app", private: true }] }]);
    // A plain workspace member is in no project they did not create (ADR-23): an owner adds them to this one first.
    const workspace = await app("GET", "/api/app/workspace", owner);
    const memberId = workspace.json.members.find((m: { email: string }) => m.email === fx.connect.memberEmail).userId;
    assert.equal((await app("POST", `/api/app/projects/${key}/members`, owner, { body: { userId: memberId, role: "viewer" } })).status, 201);
    const member = await status(await signIn(fx.connect.memberEmail), key);
    assert.deepEqual([member.json.configured, member.json.isOwner, member.json.installations], [true, false, []]);
  });

  test("connecting reads the name and branch from GitHub, then the repository is no longer on offer, and connecting it again is a 409", async () => {
    const { owner, key } = await fresh();
    const r = await connect(owner, key, { ...own, role: "  backend ", pathLimit: "" });
    assert.equal(r.status, 201, r.text);
    const repo = r.json.repository;
    assert.deepEqual([repo.displayName, repo.githubFullName, repo.provider, repo.defaultBranch, repo.role, repo.pathLimit, repo.browsable], ["connect-app", "ct/connect-app", "github", "trunk", "backend", null, true]);
    assert.equal(repo.githubInstallationId, undefined);
    assert.deepEqual((await status(owner, key)).json.installations[0].repositories, []);
    const again = await connect(owner, key, own);
    assert.equal(again.status, 409);
    assert.match(again.json.error.message, /already connected to this project/);
    // Another project of the same workspace can still connect it.
    const other = await fresh();
    assert.equal((await status(other.owner, other.key)).json.installations[0].repositories.length, 1);
  });

  test("the role defaults to 'code'; a path limit is kept", async () => {
    const { owner, key } = await fresh();
    const r = await connect(owner, key, { ...own, pathLimit: "packages/api/" });
    assert.deepEqual([r.json.repository.role, r.json.repository.pathLimit], ["code", "packages/api/"]);
  });

  test("only owners connect; the installation must be the workspace's own; the repository must be one GitHub lists for it", async () => {
    const { owner, key } = await fresh();
    const asMember = await connect(await signIn(fx.connect.memberEmail), key, own);
    assert.equal(asMember.status, 403);
    assert.match(asMember.json.error.message, /Only workspace owners/);
    // Workspace B's owner, on their own project, using the connect workspace's installation (or workspace A's).
    const b = await signIn(fx.b.email);
    const before = (await app("GET", `/api/app/projects/${fx.b.projectKey}/repositories`, b)).json.repositories.length;
    for (const installationId of [gh.installationC, gh.installationA]) {
      const stolen = await connect(b, fx.b.projectKey, { installationId, repoId: gh.connectRepoId });
      assert.equal(stolen.status, 403, installationId);
      assert.match(stolen.json.error.message, /not connected to your workspace/);
    }
    assert.equal((await connect(owner, key, { installationId: gh.installationC, repoId: "999999" })).status, 404);
    for (const [body, field] of [[{ repoId: "1" }, "installationId"], [{ installationId: "1" }, "repoId"], [{ installationId: 1, repoId: "1" }, "installationId"]] as const) {
      const r = await connect(owner, key, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field]);
    }
    assert.equal((await app("GET", `/api/app/projects/${key}/repositories`, owner)).json.repositories.length, 0, "nothing was connected");
    assert.equal((await app("GET", `/api/app/projects/${fx.b.projectKey}/repositories`, b)).json.repositories.length, before, "workspace B's project is as it was");
  });

  test("another workspace's project is a 404", async () => {
    const { key } = await fresh();
    const b = await signIn(fx.b.email);
    assert.equal((await status(b, key)).status, 404);
    assert.equal((await connect(b, key, { installationId: gh.installationB, repoId: gh.repoId })).status, 404);
  });

  test("the file tree of a connected repository, for the anchor picker; a local repository has none; another workspace cannot browse it", async () => {
    const { owner, key } = await fresh();
    const id = (await connect(owner, key, own)).json.repository.id;
    const r = await app("GET", `/api/app/projects/${key}/repositories/${id}/tree`, owner);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { files: [LANDED_FILE], truncated: false });
    const local = (await app("POST", `/api/app/projects/${key}/repositories`, owner, { body: { displayName: "Local", role: "x" } })).json.repository.id;
    const none = await app("GET", `/api/app/projects/${key}/repositories/${local}/tree`, owner);
    assert.equal(none.status, 400);
    assert.match(none.json.error.message, /not connected to GitHub/);
    const b = await signIn(fx.b.email);
    assert.equal((await app("GET", `/api/app/projects/${fx.b.projectKey}/repositories/${id}/tree`, b)).status, 404);
    assert.equal((await app("GET", `/api/app/projects/${key}/repositories/${id}/tree`, b)).status, 404);
  });
});

describe("onboarding", () => {
  test("the page: the project, whether it has a repository, and the commands with its key and this server's address, and no API key", async () => {
    const t = await workspace();
    const r = await app("GET", "/api/app/projects/DOC/onboarding", t.s);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.project, r.json.hasRepos], [{ key: "DOC", name: "Docs project" }, false]);
    assert.match(r.json.setup.linkRepo, /\/wheelhouse:setup DOC$/);
    assert.match(r.json.setup.buildMap, /map-codebase DOC/);
    assert.ok(!r.text.includes(t.key), "the agent's key is nowhere in it");
    assert.ok(!/whk_[A-Za-z0-9]{10,}/.test(r.text), "no key-shaped text");
    await app("POST", "/api/app/projects/DOC/repositories", t.s, { body: { displayName: "App", role: "web" } });
    assert.equal((await app("GET", "/api/app/projects/DOC/onboarding", t.s)).json.hasRepos, true);
  });

  test("'no code yet': a few sentences become the map's first concept", async () => {
    const t = await workspace();
    const r = await app("POST", "/api/app/projects/DOC/onboarding/concept", t.s, { body: { description: "  A tool that imports vendor invoices.  " } });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    const node = (await app("GET", "/api/app/projects/DOC/graph", t.s)).json.nodes.find((n: { layer: string }) => n.layer === "concept");
    assert.deepEqual([node.name, node.summary, node.purpose], ["Docs project", "A tool that imports vendor invoices.", "A tool that imports vendor invoices."]);
  });

  test("an empty description is a 400 on that field, with the usual message; a long one is cut to a 200 character summary", async () => {
    const t = await workspace();
    for (const body of [{}, { description: "   " }]) {
      const r = await app("POST", "/api/app/projects/DOC/onboarding/concept", t.s, { body });
      assert.equal(r.status, 400);
      assert.equal(r.json.error.details.fields.description, "Write a few sentences about what you're building.");
    }
    assert.equal((await app("POST", "/api/app/projects/DOC/onboarding/concept", t.s, { body: { description: 5 } })).status, 400);
    await app("POST", "/api/app/projects/DOC/onboarding/concept", t.s, { body: { description: "w".repeat(500) } });
    const node = (await app("GET", "/api/app/projects/DOC/graph", t.s)).json.nodes.find((n: { layer: string }) => n.layer === "concept");
    assert.deepEqual([node.summary.length, node.purpose.length], [200, 500]);
  });

  test("signed out is a 401; another workspace's project is a 404 and nothing is written", async () => {
    const mine = await workspace("Mine");
    const theirs = await workspace("Theirs");
    assert.equal((await app("GET", "/api/app/projects/DOC/onboarding", anon())).status, 401);
    assert.equal((await app("POST", "/api/app/projects/NOPE/onboarding/concept", mine.s, { body: { description: "x" } })).status, 404);
    const g = (await app("GET", "/api/app/projects/DOC/graph", theirs.s)).json;
    assert.equal(g.nodes.length, 0);
    assert.equal((await app("POST", "/api/app/projects/DOC/onboarding/concept", anon(), { body: { description: "x" } })).status, 401);
  });
});
