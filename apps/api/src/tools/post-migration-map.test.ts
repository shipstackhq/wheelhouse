/**
 * What the map says about Wheelhouse after the move to NestJS + React (WH-101), on a small map shaped like the real one. Runs through
 * the real service layer on a throwaway database. The point: the new structure is right, text edited by hand is not clobbered, and a
 * second run changes nothing.
 */
process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../db";
import type { Actor } from "../lib/access";
import * as svc from "../lib/service";
import { postMigrationMap } from "./post-migration-map";

let actor: Actor;
const P = "WH";
const graph = () => svc.getGraph(actor, P);
const named = async (name: string) => (await graph()).nodes.find((n) => n.name === name)!;
const edge = async (from: string, to: string) => {
  const g = await graph();
  const [f, t] = [g.nodes.find((n) => n.name === from), g.nodes.find((n) => n.name === to)];
  return g.edges.find((e) => e.fromNodeId === f?.id && e.toNodeId === t?.id);
};

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: "Map workspace" }).returning();
  const [user] = await db.insert(schema.users).values({ email: "map@example.test", name: "Mia", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
  actor = { kind: "human", id: user.id, name: user.name, workspaceId: workspace.id };
  await svc.createTeam(actor, { name: "Wheelhouse", key: P });
  const n = (name: string, layer: schema.Layer, extra: Partial<svc.NodeInput> = {}) => svc.upsertNode(actor, P, { name, layer, forcePublish: true, ...extra });
  await n("web", "system", { kind: "service", summary: "Next.js app: UI, server actions, MCP + REST, installable as a PWA" });
  await n("MCP server", "system", { kind: "module", parent: "web", details: "- `src/app/mcp/route.ts`\n- tools in `src/lib/tools.ts`" });
  await n("Service layer", "system", {
    kind: "module",
    parent: "web",
    interfaces: "Called by UI server actions, the REST API and the MCP server through tools.ts.",
    gotchas: "Never write to the DB from routes directly or the queue misses the change.",
    responsibilities: "- Tickets, comments, map",
  });
  await n("Board UI", "system", { kind: "component", parent: "web", details: "Server actions in src/app/actions.ts (createTicketAction, moveTicketAction, ...). Board props: columns." });
  await n("Map UI", "system", { kind: "component", parent: "web" });
  await n("Postgres", "system", { kind: "database" });
  await n("Claude API", "system", { kind: "external" });
  await n("GitHub", "system", { kind: "external" });
  await n("Repository connection", "concept", { kind: "capability" });
  await n("src/lib", "code", { kind: "directory" });
  const e = (from: string, to: string, label: string) => svc.upsertEdge(actor, P, { from, to, label });
  await e("web", "Postgres", "SQL");
  await e("Board UI", "Service layer", "server actions");
  await e("Map UI", "Service layer", "server actions");
  await e("Map UI", "Claude API", "Ask");
  await e("GitHub", "Service layer", "webhooks (planned)");
  const g = await graph();
  const id = (name: string) => g.nodes.find((x) => x.name === name)!.id;
  await svc.upsertFlow(actor, P, {
    name: "Agent picks up a ticket",
    steps: [
      { node: id("Board UI"), title: "Server action calls moveTicket", detail: "" },
      { node: id("Service layer"), title: "Updates the ticket", detail: "Version bumps." },
    ],
  });
  await svc.upsertDecision(actor, P, { title: "Migrate from Next.js to NestJS + React under a feature freeze", status: "accepted", consequences: "No drift." });
  await svc.upsertDecision(actor, P, { title: "The API is an ESM NestJS app run with tsx, with explicit injection", status: "proposed", consequences: "Needs no build, but production packaging (WH-99) must either bundle it with esbuild or keep running tsx. More." });
});

describe("the map after the migration", () => {
  test("the first run says what it did, and the structure is right", async () => {
    const r = await postMigrationMap();
    assert.deepEqual(r.skipped, []);
    assert.ok(r.did.length > 20, r.did.join("; "));

    const web = await named("web");
    assert.match(web.summary, /^React app/);
    assert.match(web.interfaces, /apps\/web\/public\/manifest\.webmanifest/);
    assert.doesNotMatch(`${web.summary} ${web.purpose} ${web.responsibilities} ${web.interfaces} ${web.gotchas}`, /server action|Next\.js|src\/app/i);

    const api = await named("API");
    assert.deepEqual([api.layer, api.kind, api.parentId, api.anchors], ["system", "service", null, ["apps/api/**"]]);
    const core = await named("core");
    assert.deepEqual([core.layer, core.anchors], ["system", ["packages/core/**"]]);
    for (const [name, parent] of [["MCP server", "API"], ["Web app API", "API"], ["GitHub webhook and connect", "API"], ["Live streams", "API"], ["Service layer", "core"]] as const) {
      assert.equal((await named(name)).parentId, (await named(parent)).id, `${name} is inside ${parent}`);
    }
    const code = (await graph()).nodes.filter((n) => n.layer === "code").map((n) => n.name);
    assert.deepEqual(code, ["packages/core/src/lib"], "the code directory node was renamed to where the code is");
  });

  test("the connections: what the web app depends on now, what no longer exists, and what each module implements", async () => {
    for (const [from, to] of [["web", "API"], ["API", "core"], ["core", "Postgres"], ["Board UI", "Web app API"], ["Map UI", "Web app API"], ["Web app API", "Service layer"], ["Web app API", "Claude API"], ["GitHub", "GitHub webhook and connect"], ["GitHub webhook and connect", "Service layer"]]) {
      assert.ok(await edge(from, to), `${from} -> ${to}`);
    }
    for (const [from, to] of [["web", "Postgres"], ["Board UI", "Service layer"], ["Map UI", "Service layer"], ["Map UI", "Claude API"], ["GitHub", "Service layer"]]) {
      assert.equal(await edge(from, to), undefined, `${from} -> ${to} is gone`);
    }
    const g = await graph();
    const impl = g.edges.find((e) => e.kind === "implements" && e.fromNodeId === g.nodes.find((n) => n.name === "GitHub webhook and connect")!.id);
    assert.equal(impl?.toNodeId, g.nodes.find((n) => n.name === "Repository connection")!.id);
  });

  test("notes and a flow that were about the Next app are corrected, and the rest of each note is kept", async () => {
    const svcLayer = await named("Service layer");
    assert.match(svcLayer.interfaces, /Called by the web app's API \(\/api\/app\), the REST API and the MCP server through tools\.ts\./);
    assert.match(svcLayer.gotchas, /^Never write to the DB from controllers or routes directly or the queue misses the change\.$/);
    assert.match(svcLayer.responsibilities, /^- Tickets, comments, map\n- A versioned edit locks the row/);
    assert.equal((await named("MCP server")).details, "- `apps/api/src/mcp/mcp.controller.ts` (the route)\n- tools in `packages/core/src/lib/tools.ts`, shared with /api/v1");
    assert.match((await named("Board UI")).details, /^Calls the API through @wheelhouse\/api-client .* Board props: columns\.$/);
    const flow = (await graph()).flows.find((f) => f.name === "Agent picks up a ticket")!;
    assert.deepEqual(flow.steps.map((s) => s.title), ["The web app calls the API, which calls moveTicket", "Updates the ticket"]);
    assert.equal(flow.steps[1].detail, "Version bumps.");
  });

  test("the glossary and the decisions: the migration is recorded as implemented, packaging is settled, and two new decisions say why", async () => {
    const g = await graph();
    assert.deepEqual(g.terms.map((t) => t.term).sort(), ["Contract suite", "Core"]);
    const adr = (title: string) => g.decisions.find((d) => d.title.startsWith(title))!;
    assert.match(adr("Migrate from Next.js").consequences, /^No drift\.\n\nImplemented \(\d{4}-\d{2}-\d{2}\): [\s\S]*removing the Next app from the repository \(WH-102\)/);
    assert.equal(adr("Migrate from Next.js").status, "accepted");
    assert.match(adr("The API is an ESM").consequences, /production packaging \(WH-99\) keeps running tsx: the image starts it as `node --import tsx src\/main\.ts`, with node as PID 1\. More\./);
    const one = adr("The React app is served by the API process");
    const lock = adr("A versioned edit locks the row");
    assert.deepEqual([one.status, lock.status], ["accepted", "accepted"]);
    assert.match(lock.context, /two simultaneous edits from the same version were both applied/);
  });

  test("the second run changes nothing", async () => {
    const before = JSON.stringify([(await graph()).nodes.map((n) => [n.id, n.version]), (await graph()).edges.length, (await graph()).decisions.map((d) => [d.number, d.version])]);
    const r = await postMigrationMap();
    assert.deepEqual(r.did, []);
    assert.equal(JSON.stringify([(await graph()).nodes.map((n) => [n.id, n.version]), (await graph()).edges.length, (await graph()).decisions.map((d) => [d.number, d.version])]), before);
  });

  test("a note someone has since edited by hand is left alone, not overwritten", async () => {
    await svc.upsertNode(actor, P, { id: (await named("Service layer")).id, interfaces: "Hand-written: everything calls this.", forcePublish: true });
    await postMigrationMap();
    assert.equal((await named("Service layer")).interfaces, "Hand-written: everything calls this.");
  });
});
