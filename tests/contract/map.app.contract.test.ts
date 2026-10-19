import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fx, v1ok } from "./lib/http";
import { anon, app, newAccount, type Sess } from "./lib/app";

/**
 * The map, decisions, glossary and activity endpoints (WH-97): the whole map in one read, nodes, layout, edges, flows, decisions,
 * terms, drafts, Ask the map, and the activity feed. Everything that changes data does it in a workspace made for the test.
 * Ask is answered by a fake Anthropic server (see lib/fake-github.ts) so the whole path can be checked, including that the
 * server's API key is in no answer.
 */
const SID = "00000000-0000-4000-8000-000000000000";
const API_KEY = fx.serverEnv.ANTHROPIC_API_KEY;

async function workspace(name = "Mapper") {
  const owner = await newAccount(name);
  const project = (await app("POST", "/api/app/projects", owner.sess, { body: { name: `${name} project`, key: "MAP" } })).json.project;
  const key = (await app("POST", "/api/app/keys", owner.sess, { body: { name: "agent" } })).json.secret as string;
  return { owner, key, project, s: owner.sess };
}

const graph = async (s: Sess, key = "MAP") => (await app("GET", `/api/app/projects/${key}/graph`, s)).json;
/** One node of the map by id. (Reporting changes makes the project add a node for its repository, so the first node is not always yours.) */
const nodeOf = (g: { nodes: { id: string }[] }, id: string) => g.nodes.find((n) => n.id === id) as Record<string, unknown> & { id: string };
const put = (s: Sess, path: string, body: unknown) => app("PUT", path, s, { body });
const node = async (s: Sess, body: Record<string, unknown>, key = "MAP") => {
  const r = await put(s, `/api/app/projects/${key}/nodes`, body);
  assert.equal(r.status, 200, r.text);
  return r.json.node;
};
const agentNode = (t: { key: string }, body: Record<string, unknown>) => v1ok({ key: t.key }, "upsert_node", { project: "MAP", ...body });

describe("every endpoint needs a signed-in person, and refuses a forged request", () => {
  const table: [string, string, unknown?][] = [
    ["GET", "/api/app/projects/MAP/graph"],
    ["PUT", "/api/app/projects/MAP/nodes", { name: "x" }],
    ["DELETE", `/api/app/projects/MAP/nodes/${SID}`],
    ["POST", `/api/app/projects/MAP/nodes/${SID}/fresh`],
    ["PUT", "/api/app/projects/MAP/layout", { positions: [{ id: SID, x: 1, y: 1 }] }],
    ["POST", "/api/app/projects/MAP/edges", { from: SID, to: SID }],
    ["DELETE", `/api/app/projects/MAP/edges/${SID}`],
    ["PUT", "/api/app/projects/MAP/flows", { name: "x" }],
    ["DELETE", `/api/app/projects/MAP/flows/${SID}`],
    ["PUT", "/api/app/projects/MAP/decisions", { title: "x" }],
    ["PUT", "/api/app/projects/MAP/terms/Thing", { definition: "x" }],
    ["DELETE", "/api/app/projects/MAP/terms/Thing"],
    ["POST", `/api/app/projects/MAP/drafts/${SID}/resolve`, { action: "publish" }],
    ["POST", "/api/app/projects/MAP/ask", { question: "x" }],
    ["GET", "/api/app/projects/MAP/activity"],
  ];
  for (const [method, path, body] of table) {
    test(`${method} ${path.replace(SID, ":id")}: 401 as JSON when signed out`, async () => {
      const r = await app(method, path, anon(), { body });
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, "unauthorized");
    });
  }

  test("a forged request (another site, no token, a wrong token) changes nothing and calls nobody", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Keep", layer: "system" });
    for (const f of [{ origin: "https://evil.example" }, { csrf: null }, { csrf: "wrong" }]) {
      for (const [method, path, body] of [
        ["PUT", "/api/app/projects/MAP/nodes", { name: "Forged" }],
        ["DELETE", `/api/app/projects/MAP/nodes/${n.id}`, undefined],
        ["PUT", "/api/app/projects/MAP/flows", { name: "Forged" }],
        ["PUT", "/api/app/projects/MAP/terms/Forged", { definition: "x" }],
        ["POST", "/api/app/projects/MAP/ask", { question: "spend money" }],
      ] as const) {
        const r = await app(method, path, t.s, { ...f, body });
        assert.equal(r.status, 403, `${method} ${path} ${JSON.stringify(f)}`);
        assert.equal(r.json.error.code, "csrf_failed");
      }
    }
    const g = await graph(t.s);
    assert.deepEqual(g.nodes.map((x: { name: string }) => x.name), ["Keep"]);
    assert.deepEqual([g.flows, g.terms], [[], []]);
  });
});

describe("GET /api/app/projects/:key/graph", () => {
  test("an empty project: the project, nothing else, and whether Ask is on", async () => {
    const t = await workspace();
    const g = await graph(t.s);
    assert.deepEqual(Object.keys(g).sort(), ["askEnabled", "decisions", "edges", "flows", "flux", "nodes", "project", "terms", "ticketLinks"]);
    assert.deepEqual(g.project, { id: t.project.id, key: "MAP", name: "Mapper project", description: "" });
    assert.deepEqual([g.nodes, g.edges, g.flows, g.decisions, g.terms, g.ticketLinks, g.flux], [[], [], [], [], [], [], {}]);
    assert.equal(g.askEnabled, true);
  });

  test("a node carries what the panel shows and nothing internal", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Gateway", layer: "system", summary: "The front door", purpose: "Why", anchors: ["src/gw/**"] });
    const g = await graph(t.s);
    assert.deepEqual(Object.keys(g.nodes[0]).sort(), ["anchors", "columns", "describedAt", "describedSha", "details", "gotchas", "height", "id", "indexes", "interfaces", "kind", "layer", "name", "parentId", "placed", "purpose", "responsibilities", "stale", "staleReason", "status", "summary", "version", "width", "x", "y"]);
    assert.equal(g.nodes[0].id, n.id);
    assert.ok(!/projectId|describedHashes|driftPaths|staleSource/.test(JSON.stringify(g)), "no internal fields");
  });

  test("everything on the map is there: edges, ticket links, flows, decisions and terms", async () => {
    const t = await workspace();
    const a = await node(t.s, { name: "Web", layer: "system" });
    const b = await node(t.s, { name: "API", layer: "system" });
    await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: a.id, to: b.id, label: "REST" } });
    await put(t.s, "/api/app/projects/MAP/flows", { name: "Sign in", steps: [{ node: a.id, title: "Open page" }, { node: b.id, title: "Check password", detail: "bcrypt" }] });
    await put(t.s, "/api/app/projects/MAP/decisions", { title: "Use REST", nodes: [b.id] });
    await put(t.s, "/api/app/projects/MAP/terms/Gateway", { definition: "The front door", node: a.id });
    const tk = await app("POST", "/api/app/projects/MAP/tickets", t.s, { body: { title: "Build web" } });
    await app("PUT", `/api/app/tickets/${tk.json.ticket.ref}/nodes/${a.id}`, t.s);
    const g = await graph(t.s);
    assert.deepEqual(g.edges.map((e: { label: string; kind: string }) => [e.kind, e.label]), [["depends", "REST"]]);
    assert.deepEqual(Object.keys(g.edges[0]).sort(), ["fromNodeId", "id", "kind", "label", "meta", "toNodeId"]);
    assert.equal(g.flows[0].steps.length, 2);
    assert.deepEqual(Object.keys(g.flows[0]).sort(), ["description", "id", "name", "steps", "version"]);
    assert.deepEqual(g.decisions.map((d: { number: number; nodeIds: string[] }) => [d.number, d.nodeIds]), [[1, [b.id]]]);
    assert.deepEqual(Object.keys(g.decisions[0]).sort(), ["authorKind", "authorName", "consequences", "context", "decision", "id", "nodeIds", "number", "status", "title", "updatedAt", "version"]);
    assert.deepEqual(g.terms.map((x: { term: string; nodeId: string }) => [x.term, x.nodeId]), [["Gateway", a.id]]);
    assert.deepEqual(Object.keys(g.terms[0]).sort(), ["definition", "id", "nodeId", "term"]);
    assert.deepEqual(g.ticketLinks.map((l: { nodeId: string; ref: string }) => [l.nodeId, l.ref]), [[a.id, "MAP-1"]]);
  });

  test("another workspace's project is a 404", async () => {
    await workspace();
    const other = await newAccount("Other");
    const r = await app("GET", "/api/app/projects/MAP/graph", other.sess);
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, "not_found");
  });
});

describe("PUT /api/app/projects/:key/nodes", () => {
  test("creates a node: the kind follows the layer and whether it is nested, and it is placed on the map", async () => {
    const t = await workspace();
    const top = await node(t.s, { name: "Shop", layer: "concept" });
    const child = await node(t.s, { name: "Cart", layer: "concept", parent: top.id });
    const sys = await node(t.s, { name: "API", layer: "system" });
    const mod = await node(t.s, { name: "Auth", layer: "system", parent: sys.id });
    const code = await node(t.s, { name: "src/auth.ts", layer: "code", parent: null });
    const tbl = await node(t.s, { name: "users", layer: "data" });
    assert.deepEqual([top.kind, child.kind, sys.kind, mod.kind, code.kind, tbl.kind], ["concept", "capability", "service", "module", "directory", "table"]);
    assert.deepEqual([top.status, top.version, child.parentId], ["planned", 1, top.id]);
    assert.equal(top.placed, false, "auto-placed, not placed by a person");
  });

  test("changes fields, bumps the version, and a change that alters nothing does not", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Svc", layer: "system" });
    const a = await node(t.s, { id: n.id, summary: "S", purpose: "P", responsibilities: "R", interfaces: "I", gotchas: "G", details: "D", status: "live", kind: "database", anchors: ["a/**", "b.ts"], version: 1 });
    assert.deepEqual([a.summary, a.purpose, a.responsibilities, a.interfaces, a.gotchas, a.details, a.status, a.kind, a.anchors, a.version], ["S", "P", "R", "I", "G", "D", "live", "database", ["a/**", "b.ts"], 2]);
    const same = await node(t.s, { id: n.id, summary: "S", version: 2 });
    assert.equal(same.version, 2);
  });

  test("a stale version is a 409 with the node as it is now, and nothing is overwritten", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Svc", layer: "system", summary: "mine" });
    await agentNode(t, { name: "Svc", layer: "system", summary: "changed by an agent" });
    const stale = await put(t.s, "/api/app/projects/MAP/nodes", { id: n.id, summary: "my slow edit", version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "conflict");
    assert.match(stale.json.error.message, /^"Svc" was changed \(version 2, you had 1\)/);
    const cur = stale.json.error.details.current;
    assert.deepEqual([cur.summary, cur.version, cur.id], ["changed by an agent", 2, n.id]);
    assert.deepEqual(Object.keys(cur).sort(), Object.keys(n).sort(), "the same trimmed node every answer uses");
    assert.ok(!/projectId|describedHashes/.test(stale.text));
    assert.equal(nodeOf(await graph(t.s), n.id).summary, "changed by an agent");
    assert.equal((await put(t.s, "/api/app/projects/MAP/nodes", { id: n.id, summary: "now", version: cur.version })).status, 200);
  });

  test("two edits from the same version: exactly one wins; without a version the change goes over whatever is there", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Race", layer: "system" });
    const [x, y] = await Promise.all(["x", "y"].map((p) => put(t.s, "/api/app/projects/MAP/nodes", { id: n.id, summary: `by ${p}`, version: 1 })));
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const free = await put(t.s, "/api/app/projects/MAP/nodes", { id: n.id, summary: "no version" });
    assert.equal(free.status, 200);
  });

  test("problems name the field: a wrong type, an unknown enum, a missing name, a bad column", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Svc", layer: "system" });
    const cases: [Record<string, unknown>, string][] = [
      [{ layer: "system" }, "name"],
      [{ name: 5 }, "name"],
      [{ name: "x", layer: "galaxy" }, "layer"],
      [{ id: n.id, status: "ready" }, "status"],
      [{ id: n.id, summary: 5 }, "summary"],
      [{ id: n.id, anchors: "a" }, "anchors"],
      [{ id: n.id, anchors: [1] }, "anchors"],
      [{ id: n.id, parent: 5 }, "parent"],
      [{ id: n.id, version: "1" }, "version"],
      [{ id: n.id, columns: "x" }, "columns"],
      [{ id: n.id, columns: [5] }, "columns"],
      [{ id: n.id, columns: [{ name: 1, type: "int" }] }, "columns"],
      [{ id: n.id, columns: [{ name: "a", type: "int", pk: "yes" }] }, "columns"],
    ];
    for (const [body, field] of cases) {
      const r = await put(t.s, "/api/app/projects/MAP/nodes", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field], `${JSON.stringify(body)} names ${field}`);
    }
  });

  test("the rules of the map are the service's: a kind from the wrong layer, columns off the data layer, a parent from another layer, a node as its own parent, moving between layers", async () => {
    const t = await workspace();
    const sys = await node(t.s, { name: "API", layer: "system" });
    const con = await node(t.s, { name: "Idea", layer: "concept" });
    const msg = async (body: Record<string, unknown>) => (await put(t.s, "/api/app/projects/MAP/nodes", body)).json.error.message as string;
    assert.match(await msg({ id: sys.id, kind: "table" }), /kind "table" isn't valid on the system layer/);
    assert.match(await msg({ id: sys.id, columns: [{ name: "a", type: "int" }] }), /columns\/indexes only apply to data-layer nodes/);
    assert.match(await msg({ name: "Child", layer: "system", parent: con.id }), /Parent must be on the same layer/);
    assert.match(await msg({ id: sys.id, parent: sys.id }), /cannot be its own parent/);
    assert.match(await msg({ id: sys.id, layer: "concept" }), /Can't move "API" between layers/);
    assert.match(await msg({ id: sys.id, columns: [] , name: "" }) , /./);
  });

  test("a table's columns are saved, a foreign key makes a relationship, and clearing it removes it", async () => {
    const t = await workspace();
    const users = await node(t.s, { name: "users", layer: "data", columns: [{ name: "id", type: "uuid", pk: true }] });
    const posts = await node(t.s, { name: "posts", layer: "data", columns: [{ name: "id", type: "uuid", pk: true }, { name: "author_id", type: "uuid", references: "users.id", onDelete: "cascade" }] });
    let g = await graph(t.s);
    const refs = g.edges.filter((e: { kind: string }) => e.kind === "references");
    assert.equal(refs.length, 1);
    assert.deepEqual([refs[0].fromNodeId, refs[0].toNodeId, refs[0].meta.fromColumn, refs[0].meta.toColumn, refs[0].meta.cardinality, refs[0].meta.derived], [posts.id, users.id, "author_id", "id", "n-1", true]);
    await node(t.s, { id: posts.id, columns: [{ name: "id", type: "uuid", pk: true }, { name: "author_id", type: "uuid" }], version: posts.version });
    g = await graph(t.s);
    assert.equal(g.edges.filter((e: { kind: string }) => e.kind === "references").length, 0);
    const bad = await put(t.s, "/api/app/projects/MAP/nodes", { id: posts.id, columns: [{ name: "x", type: "int", references: "nodots" }] });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /references must look like "table.column"/);
  });

  test("another workspace's node cannot be changed by id: a 404, and it is untouched", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    const n = await node(a.s, { name: "Secret", layer: "system", summary: "private" });
    const r = await put(b.s, "/api/app/projects/MAP/nodes", { id: n.id, summary: "hacked" });
    assert.equal(r.status, 404);
    assert.equal(nodeOf(await graph(a.s), n.id).summary, "private");
    assert.deepEqual((await graph(b.s)).nodes, []);
  });
});

describe("DELETE /api/app/projects/:key/nodes/:id", () => {
  test("removes the node and everything nested in it, with its links, and says so in the activity", async () => {
    const t = await workspace();
    const parent = await node(t.s, { name: "Parent", layer: "system" });
    const child = await node(t.s, { name: "Child", layer: "system", parent: parent.id });
    const other = await node(t.s, { name: "Other", layer: "system" });
    await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: other.id, to: child.id } });
    assert.deepEqual((await app("DELETE", `/api/app/projects/MAP/nodes/${parent.id}`, t.s)).json, { ok: true });
    const g = await graph(t.s);
    assert.deepEqual(g.nodes.map((n: { name: string }) => n.name), ["Other"]);
    assert.deepEqual(g.edges, []);
    const events = (await app("GET", "/api/app/projects/MAP/activity", t.s)).json.events;
    assert.ok(events.some((e: { summary: string }) => /removed system service "Parent" and 1 nested/.test(e.summary)));
    assert.equal((await app("DELETE", `/api/app/projects/MAP/nodes/${parent.id}`, t.s)).status, 404, "asking again");
  });

  test("another workspace's node is a 404 and survives", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    const n = await node(a.s, { name: "Mine", layer: "system" });
    assert.equal((await app("DELETE", `/api/app/projects/MAP/nodes/${n.id}`, b.s)).status, 404);
    assert.equal((await graph(a.s)).nodes.length, 1);
  });
});

describe("PUT /api/app/projects/:key/layout", () => {
  test("saves positions and sizes, marks them as placed by a person, and does not bump the version", async () => {
    const t = await workspace();
    const a = await node(t.s, { name: "A", layer: "system" });
    const b = await node(t.s, { name: "B", layer: "system" });
    const r = await put(t.s, "/api/app/projects/MAP/layout", { positions: [{ id: a.id, x: 100.4, y: 50 }, { id: b.id, x: 7, y: 9, width: 300, height: 200 }] });
    assert.deepEqual(r.json, { ok: true });
    const g = await graph(t.s);
    const [ga, gb] = [a.id, b.id].map((id) => g.nodes.find((n: { id: string }) => n.id === id));
    assert.deepEqual([ga.x, ga.y, ga.placed, ga.version], [100.4, 50, true, 1]);
    assert.deepEqual([gb.x, gb.y, gb.width, gb.height], [7, 9, 300, 200]);
  });

  test("a whole-lens Tidy passes placed: false, so a later automatic pass may move them again", async () => {
    const t = await workspace();
    const a = await node(t.s, { name: "A", layer: "system" });
    await put(t.s, "/api/app/projects/MAP/layout", { positions: [{ id: a.id, x: 1, y: 2 }], placed: false });
    assert.equal((await graph(t.s)).nodes[0].placed, false);
  });

  test("a bad list is a 400 that names it: empty, not a list, a position that is not a number, no id, placed that is not true or false", async () => {
    const t = await workspace();
    const a = await node(t.s, { name: "A", layer: "system" });
    for (const body of [{}, { positions: [] }, { positions: "x" }, { positions: [{ id: a.id, x: "1", y: 2 }] }, { positions: [{ x: 1, y: 2 }] }, { positions: [{ id: a.id, x: 1, y: 2 }], placed: "yes" }, { positions: [{ id: a.id, x: null, y: 2 }] }]) {
      const r = await put(t.s, "/api/app/projects/MAP/layout", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.error.code, "invalid");
    }
    assert.equal((await graph(t.s)).nodes[0].x, a.x, "nothing moved");
  });

  test("another workspace's node ids move nothing", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    const n = await node(a.s, { name: "Mine", layer: "system" });
    await put(b.s, "/api/app/projects/MAP/layout", { positions: [{ id: n.id, x: 9999, y: 9999 }] });
    assert.notEqual((await graph(a.s)).nodes[0].x, 9999);
  });
});

describe("edges", () => {
  test("connect two nodes: a label is kept, the same connection again is the same edge, and a new label renames it", async () => {
    const t = await workspace();
    const a = await node(t.s, { name: "A", layer: "system" });
    const b = await node(t.s, { name: "B", layer: "system" });
    const first = await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: a.id, to: b.id } });
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.json.edge).sort(), ["fromNodeId", "id", "kind", "label", "meta", "toNodeId"]);
    const again = await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: a.id, to: b.id, label: "REST" } });
    assert.equal(again.json.edge.id, first.json.edge.id);
    assert.equal(again.json.edge.label, "REST");
    assert.equal((await graph(t.s)).edges.length, 1);
  });

  test("implements goes from a lower layer to a higher one; connecting a node to itself is refused; references are made with columns", async () => {
    const t = await workspace();
    const code = await node(t.s, { name: "src/a.ts", layer: "code" });
    const sys = await node(t.s, { name: "API", layer: "system" });
    const ok = await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: code.id, to: sys.id, kind: "implements" } });
    assert.equal(ok.json.edge.kind, "implements");
    const wrong = await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: sys.id, to: code.id, kind: "implements" } });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error.message, /implements goes from a lower layer to a higher one/);
    assert.match((await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: sys.id, to: sys.id } })).json.error.message, /Can't connect a node to itself/);
    const refs = await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: sys.id, to: code.id, kind: "references" } });
    assert.equal(refs.status, 400);
    assert.ok(refs.json.error.details.fields.kind);
  });

  test("problems name the field; a node of another workspace is a 404 and nothing is connected", async () => {
    const t = await workspace();
    const other = await workspace("Other");
    const mine = await node(t.s, { name: "Mine", layer: "system" });
    const foreign = await node(other.s, { name: "Foreign", layer: "system" });
    for (const [body, field] of [[{ to: mine.id }, "from"], [{ from: mine.id }, "to"], [{ from: 1, to: mine.id }, "from"], [{ from: mine.id, to: mine.id, label: 5 }, "label"]] as const) {
      const r = await app("POST", "/api/app/projects/MAP/edges", t.s, { body });
      assert.equal(r.status, 400);
      assert.ok(r.json.error.details.fields[field]);
    }
    assert.equal((await app("POST", "/api/app/projects/MAP/edges", t.s, { body: { from: mine.id, to: foreign.id } })).status, 404);
    assert.deepEqual((await graph(t.s)).edges, []);
  });

  test("deleting an edge removes it; asking again is fine; another workspace's edge is not touched", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    const x = await node(a.s, { name: "X", layer: "system" });
    const y = await node(a.s, { name: "Y", layer: "system" });
    const e = (await app("POST", "/api/app/projects/MAP/edges", a.s, { body: { from: x.id, to: y.id } })).json.edge;
    assert.deepEqual((await app("DELETE", `/api/app/projects/MAP/edges/${e.id}`, b.s)).json, { ok: true }, "another workspace's: a no-op");
    assert.equal((await graph(a.s)).edges.length, 1, "still there");
    assert.deepEqual((await app("DELETE", `/api/app/projects/MAP/edges/${e.id}`, a.s)).json, { ok: true });
    assert.deepEqual((await graph(a.s)).edges, []);
    assert.deepEqual((await app("DELETE", `/api/app/projects/MAP/edges/${e.id}`, a.s)).json, { ok: true });
  });
});

describe("flows", () => {
  test("a flow is created with its steps in order, and changed with the version it was read at", async () => {
    const t = await workspace();
    const a = await node(t.s, { name: "Web", layer: "system" });
    const b = await node(t.s, { name: "API", layer: "system" });
    const made = await put(t.s, "/api/app/projects/MAP/flows", { name: "Sign in", description: "How", steps: [{ node: a.id, title: "Open" }, { node: b.id, title: "Check", detail: "bcrypt" }] });
    assert.equal(made.status, 200);
    const f = made.json.flow;
    assert.deepEqual([f.name, f.version, f.steps.map((s: { nodeId: string; title: string; detail: string }) => [s.nodeId, s.title, s.detail])], ["Sign in", 1, [[a.id, "Open", ""], [b.id, "Check", "bcrypt"]]]);
    const edited = await put(t.s, "/api/app/projects/MAP/flows", { id: f.id, name: "Sign in", steps: [{ node: b.id, title: "Only" }], version: 1 });
    assert.deepEqual([edited.json.flow.version, edited.json.flow.steps.length, edited.json.flow.description], [2, 1, "How"]);
  });

  test("a stale version is a 409 with the flow as it is now, and nothing is overwritten", async () => {
    const t = await workspace();
    const a = await node(t.s, { name: "Web", layer: "system" });
    const f = (await put(t.s, "/api/app/projects/MAP/flows", { name: "F", steps: [{ node: a.id, title: "one" }] })).json.flow;
    await put(t.s, "/api/app/projects/MAP/flows", { id: f.id, name: "F renamed", version: 1 });
    const stale = await put(t.s, "/api/app/projects/MAP/flows", { id: f.id, name: "Slow", version: 1 });
    assert.equal(stale.status, 409);
    assert.match(stale.json.error.message, /^Flow "F renamed" was changed \(version 2, you had 1\)/);
    assert.deepEqual([stale.json.error.details.current.name, stale.json.error.details.current.version], ["F renamed", 2]);
    assert.equal((await graph(t.s)).flows[0].name, "F renamed");
  });

  test("problems: no name, steps that are not a list, a step with no node or no title, a node that is not on the map", async () => {
    const t = await workspace();
    const a = await node(t.s, { name: "Web", layer: "system" });
    for (const [body, field] of [[{}, "name"], [{ name: "  " }, "name"], [{ name: "F", steps: "x" }, "steps"], [{ name: "F", steps: [5] }, "steps"], [{ name: "F", steps: [{ title: "t" }] }, "node"], [{ name: "F", steps: [{ node: a.id }] }, "title"], [{ name: "F", description: 5 }, "description"]] as const) {
      const r = await put(t.s, "/api/app/projects/MAP/flows", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field], `${JSON.stringify(body)} names ${field}`);
    }
    assert.equal((await put(t.s, "/api/app/projects/MAP/flows", { name: "F", steps: [{ node: SID, title: "t" }] })).status, 404);
    assert.deepEqual((await graph(t.s)).flows, []);
  });

  test("a step cannot point at another workspace's node, and another workspace's flow cannot be deleted", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    const foreign = await node(b.s, { name: "Foreign", layer: "system" });
    assert.equal((await put(a.s, "/api/app/projects/MAP/flows", { name: "F", steps: [{ node: foreign.id, title: "t" }] })).status, 404);
    const mine = await node(a.s, { name: "Mine", layer: "system" });
    const f = (await put(a.s, "/api/app/projects/MAP/flows", { name: "Mine", steps: [{ node: mine.id, title: "t" }] })).json.flow;
    assert.equal((await app("DELETE", `/api/app/projects/MAP/flows/${f.id}`, b.s)).status, 404);
    assert.deepEqual((await app("DELETE", `/api/app/projects/MAP/flows/${f.id}`, a.s)).json, { ok: true });
    assert.equal((await app("DELETE", `/api/app/projects/MAP/flows/${f.id}`, a.s)).status, 404);
  });
});

describe("decisions", () => {
  test("recording one numbers it in order, and editing it by number bumps the version", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "API", layer: "system" });
    const one = (await put(t.s, "/api/app/projects/MAP/decisions", { title: "First", context: "c", decision: "d", consequences: "q", nodes: [n.id] })).json.decision;
    const two = (await put(t.s, "/api/app/projects/MAP/decisions", { title: "Second", status: "proposed" })).json.decision;
    assert.deepEqual([one.number, one.status, one.version, one.nodeIds, one.authorKind, one.authorName], [1, "accepted", 1, [n.id], "human", "Mapper"]);
    assert.deepEqual([two.number, two.status], [2, "proposed"]);
    const edited = (await put(t.s, "/api/app/projects/MAP/decisions", { number: 2, status: "accepted", decision: "chosen", version: 1 })).json.decision;
    assert.deepEqual([edited.number, edited.status, edited.decision, edited.version, edited.title], [2, "accepted", "chosen", 2, "Second"]);
    assert.equal((await put(t.s, "/api/app/projects/MAP/decisions", { number: 2, status: "accepted", version: 2 })).json.decision.version, 2, "no change, no new version");
  });

  test("a stale version is a 409 with the decision as it is now", async () => {
    const t = await workspace();
    await put(t.s, "/api/app/projects/MAP/decisions", { title: "ADR" });
    await put(t.s, "/api/app/projects/MAP/decisions", { number: 1, title: "Renamed", version: 1 });
    const stale = await put(t.s, "/api/app/projects/MAP/decisions", { number: 1, title: "Slow", version: 1 });
    assert.equal(stale.status, 409);
    assert.match(stale.json.error.message, /^ADR-1 was changed \(version 2, you had 1\)/);
    assert.equal(stale.json.error.details.current.title, "Renamed");
    assert.equal((await graph(t.s)).decisions[0].title, "Renamed");
  });

  test("problems: no title, a status that is not one, text that is not text, a number that does not exist, a node that is not on the map", async () => {
    const t = await workspace();
    for (const [body, field] of [[{}, "title"], [{ title: "  " }, "title"], [{ title: "x", status: "maybe" }, "status"], [{ title: "x", context: 5 }, "context"], [{ title: "x", nodes: "a" }, "nodes"], [{ number: "1" }, "number"]] as const) {
      const r = await put(t.s, "/api/app/projects/MAP/decisions", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details?.fields?.[field] ?? r.json.error.message, field);
    }
    assert.equal((await put(t.s, "/api/app/projects/MAP/decisions", { number: 9, title: "x" })).status, 404);
    assert.equal((await put(t.s, "/api/app/projects/MAP/decisions", { title: "x", nodes: [SID] })).status, 404);
    assert.deepEqual((await graph(t.s)).decisions, []);
  });

  test("another workspace's decision numbers are its own: ADR-1 of one workspace is not ADR-1 of another, and cannot be edited across", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    await put(a.s, "/api/app/projects/MAP/decisions", { title: "A's" });
    await put(b.s, "/api/app/projects/MAP/decisions", { title: "B's" });
    await put(a.s, "/api/app/projects/MAP/decisions", { number: 1, title: "A's, edited" });
    assert.equal((await graph(b.s)).decisions[0].title, "B's");
    assert.equal((await put(b.s, "/api/app/projects/MAP/decisions", { number: 2, title: "x" })).status, 404);
  });
});

describe("glossary terms", () => {
  test("defining a term, redefining it by name in any case, linking it to a concept, and removing it", async () => {
    const t = await workspace();
    const c = await node(t.s, { name: "Billing", layer: "concept" });
    const made = await put(t.s, "/api/app/projects/MAP/terms/Invoice", { definition: "A bill", node: c.id });
    assert.deepEqual([made.json.term.term, made.json.term.definition, made.json.term.nodeId], ["Invoice", "A bill", c.id]);
    const again = await put(t.s, "/api/app/projects/MAP/terms/invoice", { definition: "A bill we send" });
    assert.equal(again.json.term.id, made.json.term.id, "the same term");
    assert.equal(again.json.term.definition, "A bill we send");
    assert.equal(again.json.term.nodeId, c.id, "no node given: the link stays");
    const unlinked = await put(t.s, "/api/app/projects/MAP/terms/Invoice", { definition: "A bill we send", node: null });
    assert.equal(unlinked.json.term.nodeId, null);
    assert.equal((await graph(t.s)).terms.length, 1);
    assert.deepEqual((await app("DELETE", `/api/app/projects/MAP/terms/${made.json.term.id}`, t.s)).json, { ok: true }, "by id");
    await put(t.s, "/api/app/projects/MAP/terms/Second", { definition: "x" });
    assert.deepEqual((await app("DELETE", "/api/app/projects/MAP/terms/second", t.s)).json, { ok: true }, "by name, in any case");
    assert.deepEqual((await graph(t.s)).terms, []);
  });

  test("a term with spaces or slashes in its name works in the path", async () => {
    const t = await workspace();
    for (const name of ["Work item", "CI/CD", "Q&A?"]) {
      const r = await put(t.s, `/api/app/projects/MAP/terms/${encodeURIComponent(name)}`, { definition: "x" });
      assert.equal(r.status, 200, name);
      assert.equal(r.json.term.term, name);
    }
    assert.equal((await graph(t.s)).terms.length, 3);
    assert.equal((await app("DELETE", `/api/app/projects/MAP/terms/${encodeURIComponent("CI/CD")}`, t.s)).status, 200);
  });

  test("problems: no definition, a definition that is not text, a node that is not on the map; removing what is not there is a 404", async () => {
    const t = await workspace();
    for (const [body, field] of [[{}, "definition"], [{ definition: "  " }, "definition"], [{ definition: 5 }, "definition"], [{ definition: "x", node: 5 }, "node"]] as const) {
      const r = await put(t.s, "/api/app/projects/MAP/terms/T", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field] ?? r.json.error.message);
    }
    assert.equal((await put(t.s, "/api/app/projects/MAP/terms/T", { definition: "x", node: SID })).status, 404);
    assert.equal((await app("DELETE", "/api/app/projects/MAP/terms/Nope", t.s)).status, 404);
  });

  test("terms are per workspace: the same word in two workspaces is two terms, and one workspace cannot remove the other's", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    const ta = (await put(a.s, "/api/app/projects/MAP/terms/Shared", { definition: "A" })).json.term;
    await put(b.s, "/api/app/projects/MAP/terms/Shared", { definition: "B" });
    assert.equal((await app("DELETE", `/api/app/projects/MAP/terms/${ta.id}`, b.s)).status, 404);
    assert.equal((await graph(a.s)).terms[0].definition, "A");
    assert.equal((await graph(b.s)).terms[0].definition, "B");
  });
});

describe("stale and in-flux markings, and drafts", () => {
  /** A node anchored to a file, described, and then the file reported changed: stale. */
  const staleNode = async (t: Awaited<ReturnType<typeof workspace>>) => {
    const n = await node(t.s, { name: "Billing", layer: "system", summary: "Takes money", anchors: ["src/billing/**"] });
    await v1ok({ key: t.key }, "report_changes", { project: "MAP", files: ["src/billing/charge.ts"], summary: "changed" });
    return n;
  };

  test("a node whose code changed is stale, with the reason; 'still accurate' clears it without changing what it says", async () => {
    const t = await workspace();
    const n = await staleNode(t);
    let g = await graph(t.s);
    assert.equal(nodeOf(g, n.id).stale, true);
    assert.match(String(nodeOf(g, n.id).staleReason), /src\/billing\/charge\.ts changed/);
    const r = await app("POST", `/api/app/projects/MAP/nodes/${n.id}/fresh`, t.s);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.node.stale, r.json.node.staleReason, r.json.node.summary], [false, null, "Takes money"]);
    g = await graph(t.s);
    assert.equal(nodeOf(g, n.id).stale, false);
  });

  test("editing a stale node's explanation clears the flag too", async () => {
    const t = await workspace();
    const n = await staleNode(t);
    const r = await put(t.s, "/api/app/projects/MAP/nodes", { id: n.id, purpose: "Now explained", version: n.version });
    assert.equal(r.json.node.stale, false);
  });

  test("code an agent's session is changing shows as in flux; its map update waits as a draft until published or discarded", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Billing", layer: "system", summary: "Takes money", anchors: ["src/billing/**"] });
    await v1ok({ key: t.key }, "session_sync", { project: "MAP", session: "sess-flux", files: ["src/billing/charge.ts"] });
    await v1ok({ key: t.key }, "upsert_node", { project: "MAP", name: "Billing", layer: "system", purpose: "Drafted while the code is in flux", session: "sess-flux" });
    let g = await graph(t.s);
    const flux = g.flux[n.id];
    assert.ok(flux, "the node is in flux");
    assert.deepEqual(flux.sessions.map((s: { files: string[] }) => s.files), [["src/billing/charge.ts"]]);
    assert.equal(flux.drafts.length, 1);
    assert.deepEqual(Object.keys(flux.drafts[0]).sort(), ["authorKind", "authorName", "confirm", "id", "patch"]);
    assert.equal(flux.drafts[0].patch.purpose, "Drafted while the code is in flux");
    assert.equal(nodeOf(g, n.id).purpose, "", "the shared map has not changed yet");

    const published = await app("POST", `/api/app/projects/MAP/drafts/${flux.drafts[0].id}/resolve`, t.s, { body: { action: "publish" } });
    assert.deepEqual(published.json, { ok: true });
    g = await graph(t.s);
    assert.equal(nodeOf(g, n.id).purpose, "Drafted while the code is in flux");
    assert.equal(g.flux[n.id].drafts.length, 0);
    const again = await app("POST", `/api/app/projects/MAP/drafts/${flux.drafts[0].id}/resolve`, t.s, { body: { action: "publish" } });
    assert.equal(again.status, 404, "already resolved");
  });

  test("a draft can be discarded, and then the map is as it was", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Billing", layer: "system", anchors: ["src/billing/**"] });
    await v1ok({ key: t.key }, "session_sync", { project: "MAP", session: "sess-d", files: ["src/billing/x.ts"] });
    await v1ok({ key: t.key }, "upsert_node", { project: "MAP", name: "Billing", layer: "system", purpose: "Never mind", session: "sess-d" });
    const draft = (await graph(t.s)).flux[n.id].drafts[0];
    assert.deepEqual((await app("POST", `/api/app/projects/MAP/drafts/${draft.id}/resolve`, t.s, { body: { action: "discard" } })).json, { ok: true });
    const g = await graph(t.s);
    assert.equal(nodeOf(g, n.id).purpose, "");
    assert.equal(g.flux[n.id]?.drafts.length ?? 0, 0);
  });

  test("the action must be publish or discard; another workspace's draft is a 404 and stays pending", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    const n = await node(a.s, { name: "Billing", layer: "system", anchors: ["src/billing/**"] });
    await v1ok({ key: a.key }, "session_sync", { project: "MAP", session: "sess-x", files: ["src/billing/x.ts"] });
    await v1ok({ key: a.key }, "upsert_node", { project: "MAP", name: "Billing", layer: "system", purpose: "p", session: "sess-x" });
    const draft = (await graph(a.s)).flux[n.id].drafts[0];
    const bad = await app("POST", `/api/app/projects/MAP/drafts/${draft.id}/resolve`, a.s, { body: { action: "explode" } });
    assert.equal(bad.status, 400);
    assert.ok(bad.json.error.details.fields.action);
    assert.equal((await app("POST", `/api/app/projects/MAP/drafts/${draft.id}/resolve`, b.s, { body: { action: "publish" } })).status, 404);
    assert.equal((await graph(a.s)).flux[n.id].drafts.length, 1, "still pending");
  });
});

describe("POST /api/app/projects/:key/ask", () => {
  const ask = (s: Sess, body: unknown, key = "MAP") => app("POST", `/api/app/projects/${key}/ask`, s, { body });
  const withMap = async (name = "Asker") => {
    const t = await workspace(name);
    await node(t.s, { name: "Gateway", layer: "system", summary: "The front door" });
    await node(t.s, { name: "Billing", layer: "concept", summary: "Takes money" });
    return t;
  };

  test("answers from the server's own call to Claude: the question reaches it with this workspace's map, and the answer is text and a flag", async () => {
    const t = await withMap();
    const r = await ask(t.s, { question: "What does the gateway do?" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ["answer", "truncated"]);
    assert.equal(r.json.truncated, false);
    assert.match(r.json.answer, /^FAKE ANSWER\./);
    assert.match(r.json.answer, /Map: # Project MAP: Asker project\./);
    assert.match(r.json.answer, /Nodes: [^.]*system:Gateway/);
    assert.match(r.json.answer, /Asked: What does the gateway do\?/);
    assert.match(r.json.answer, /Server-side key sent: yes/);
  });

  test("the API key is in no answer: not in the body, the headers or the cookies, whatever happens upstream", async () => {
    const t = await withMap();
    assert.ok(API_KEY && API_KEY.startsWith("sk-ant-"), "the server under test has a key to leak");
    for (const question of ["plain question", "FAIL-AUTH please", "FAIL-RATE please", "FAIL-500 please", "TRUNCATE this"]) {
      const r = await ask(t.s, { question });
      const everything = r.text + JSON.stringify([...r.headers.entries()]) + r.cookies.join(";");
      assert.ok(!everything.includes(API_KEY), `${question}: no key in the answer`);
      assert.ok(!everything.includes("7d1f"), `${question}: no part of it either`);
    }
    const graphText = JSON.stringify(await graph(t.s));
    assert.ok(!graphText.includes(API_KEY), "nor in the map");
  });

  test("a focus node is passed on, so the question is about it", async () => {
    const t = await withMap();
    const g = await graph(t.s);
    const focus = g.nodes.find((n: { name: string }) => n.name === "Gateway");
    const r = await ask(t.s, { question: "Why?", focus: focus.id });
    assert.match(r.json.answer, /Asked: I'm looking at \[\[system:Gateway\]\]\. Why\?/);
  });

  test("an answer cut off by the length limit says so", async () => {
    const t = await withMap();
    assert.equal((await ask(t.s, { question: "TRUNCATE this" })).json.truncated, true);
  });

  test("when Claude fails the person gets a plain reason, and no status or key from upstream", async () => {
    const t = await withMap();
    const msg = async (q: string) => (await ask(t.s, { question: q })).json.error.message as string;
    assert.equal(await msg("FAIL-RATE"), "Claude is rate limited, try again in a moment");
    assert.equal(await msg("FAIL-AUTH"), "ANTHROPIC_API_KEY is invalid");
    assert.equal(await msg("FAIL-500"), "Claude API error (500)");
  });

  test("an empty map, no question, a question that is too long or not text: a 400 that says what to do, and nothing is called", async () => {
    const t = await workspace();
    const empty = await ask(t.s, { question: "Hello?" });
    assert.equal(empty.status, 400);
    assert.match(empty.json.error.message, /The map is empty\. Map the codebase first\./);
    await node(t.s, { name: "Gateway", layer: "system" });
    for (const [body, field] of [[{}, "question"], [{ question: "   " }, "question"], [{ question: 5 }, "question"], [{ question: "x".repeat(4001) }, "question"], [{ question: "ok", focus: 5 }, "focus"]] as const) {
      const r = await ask(t.s, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
      assert.ok(r.json.error.details.fields[field], field);
    }
  });

  test("another workspace's project is a 404 before anything is counted or called; the answer holds only the caller's own map", async () => {
    const a = await withMap("Alpha");
    const b = await newAccount("Beta");
    await app("POST", "/api/app/projects", b.sess, { body: { name: "Beta project", key: "BET" } });
    await node(b.sess, { name: "SecretBetaThing", layer: "system" }, "BET");
    const cross = await ask(b.sess, { question: "What does Alpha do?" }, "MAP");
    assert.equal(cross.status, 404);
    assert.equal(cross.json.error.code, "not_found");
    assert.ok(!cross.text.includes("Gateway"), "nothing of the other workspace's map");
    const own = await ask(b.sess, { question: "What do I have?" }, "BET");
    assert.match(own.json.answer, /# Project BET: Beta project/);
    assert.match(own.json.answer, /SecretBetaThing/);
    assert.ok(!own.json.answer.includes("Gateway") && !own.json.answer.includes("Alpha project"), "Alpha's map is not in Beta's prompt");
    assert.match((await ask(a.s, { question: "Mine?" })).json.answer, /# Project MAP: Alpha project/);
  });

  test("twenty questions in ten minutes per person, then 429 with Retry-After; refused questions about foreign projects do not count", async () => {
    const t = await withMap();
    const other = await newAccount("Other");
    for (let i = 0; i < 25; i++) assert.equal((await ask(other.sess, { question: "peek" }, "MAP")).status, 404);
    for (let i = 0; i < 20; i++) assert.equal((await ask(t.s, { question: `q${i}` })).status, 200, `question ${i + 1}`);
    const limited = await ask(t.s, { question: "one too many" });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, "rate_limited");
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
    // the person who only asked about someone else's project still has all their own questions (after making a map)
    await app("POST", "/api/app/projects", other.sess, { body: { name: "Mine", key: "OWN" } });
    await node(other.sess, { name: "Thing", layer: "system" }, "OWN");
    assert.equal((await ask(other.sess, { question: "ok now" }, "OWN")).status, 200);
  });
});

describe("GET /api/app/projects/:key/activity", () => {
  test("the project's events, newest first, with who did what, linking data and nothing else", async () => {
    const t = await workspace();
    const n = await node(t.s, { name: "Gateway", layer: "system" });
    const tk = (await app("POST", "/api/app/projects/MAP/tickets", t.s, { body: { title: "Do it" } })).json.ticket;
    await app("POST", `/api/app/tickets/${tk.ref}/comments`, t.s, { body: { body: "Looks right" } });
    await put(t.s, "/api/app/projects/MAP/decisions", { title: "ADR" });
    const r = await app("GET", "/api/app/projects/MAP/activity", t.s);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ["events"]);
    const ev = r.json.events;
    assert.ok(ev.length >= 4);
    assert.deepEqual(ev.map((e: { seq: number }) => e.seq), [...ev.map((e: { seq: number }) => e.seq)].sort((a: number, b: number) => b - a), "newest first");
    assert.deepEqual(Object.keys(ev[0]).sort(), ["actorKind", "actorName", "createdAt", "data", "entity", "entityId", "seq", "summary", "type"]);
    const comment = ev.find((e: { type: string }) => e.type === "comment.created");
    assert.deepEqual([comment.data.ref, comment.data.body, comment.actorKind, comment.actorName], [tk.ref, "Looks right", "human", "Mapper"]);
    assert.equal(ev.find((e: { type: string }) => e.type === "decision.created").data.number, 1);
    assert.equal(ev.find((e: { type: string }) => e.type === "node.created").entityId, n.id);
    for (const e of ev) assert.ok(Object.keys(e.data).every((k) => ["ref", "number", "body"].includes(k)), "only what the page links with");
  });

  test("a comment's text is cut at 500 characters", async () => {
    const t = await workspace();
    const tk = (await app("POST", "/api/app/projects/MAP/tickets", t.s, { body: { title: "Long" } })).json.ticket;
    await app("POST", `/api/app/tickets/${tk.ref}/comments`, t.s, { body: { body: "x".repeat(900) } });
    const c = (await app("GET", "/api/app/projects/MAP/activity", t.s)).json.events.find((e: { type: string }) => e.type === "comment.created");
    assert.equal(c.data.body.length, 500);
  });

  test("?who=agent shows only agents, ?who=human only people, anything else everyone", async () => {
    const t = await workspace();
    await node(t.s, { name: "By a person", layer: "system" });
    await agentNode(t, { name: "By an agent", layer: "system" });
    const get = async (q: string) => (await app("GET", `/api/app/projects/MAP/activity${q}`, t.s)).json.events;
    const agents = await get("?who=agent");
    const humans = await get("?who=human");
    const all = await get("?who=whatever");
    assert.ok(agents.length > 0 && agents.every((e: { actorKind: string }) => e.actorKind === "agent"));
    assert.ok(humans.length > 0 && humans.every((e: { actorKind: string }) => e.actorKind === "human"));
    assert.equal(all.length, agents.length + humans.length);
  });

  test("another workspace's project is a 404, and an event of one workspace never shows in another's feed", async () => {
    const a = await workspace();
    const b = await workspace("Other");
    await node(a.s, { name: "OnlyInA", layer: "system" });
    assert.equal((await app("GET", "/api/app/projects/MAP/activity", b.s)).status, 200, "b's own project with the same key");
    const feed = JSON.stringify((await app("GET", "/api/app/projects/MAP/activity", b.s)).json);
    assert.ok(!feed.includes("OnlyInA"));
    const stranger = await newAccount("Stranger");
    assert.equal((await app("GET", "/api/app/projects/MAP/activity", stranger.sess)).status, 404);
  });
});
