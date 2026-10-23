import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "../lib/access";
import * as svc from "../lib/service";

/**
 * What the knowledge map says about Wheelhouse itself, after the move from Next.js to NestJS + React (WH-101). The anchors are handled by
 * reanchor.ts; this is the part that is about meaning: the web node is now the React app, the API and the core package are services of
 * their own, the connections between them changed, and a few things in notes, one flow and some ADRs were written about the Next app.
 *
 * It goes through the service layer (so every change is an event, versions move on, and a node edited here is baselined at the next landing)
 * and is idempotent: run twice, the second run changes nothing. Text that was edited by hand since is left alone where the sentence this
 * expects is gone, and reported. Run it on the imported data before the new app starts (docs/cutover.md), never on the old app's data.
 */

const TEAM = "WH";

export type Outcome = { did: string[]; skipped: string[] };

const WEB = {
  summary: "React app: the whole UI, installable as a PWA; talks only to the API",
  purpose:
    "The browser side of Wheelhouse: the board and ticket dialog, the map, docs, decisions, glossary and activity, repositories, onboarding, workspace, agents and admin pages. It holds no business rule and no data access: everything it shows or changes goes through the API's /api/app endpoints, so what a person can do in the UI is exactly what the API allows.",
  responsibilities: [
    "- Pages at the same addresses the Next app had (/t/:key/map, /t/:key/docs, /agents, ...), so links, bookmarks and the links the plugin prints keep working.",
    "- Sign-in is a router guard: signed out goes to /login before anything renders.",
    "- Reads with TanStack Query; every change reads again what may show it. Live updates: the team's and the workspace's SSE streams invalidate every query, so a change by an agent shows within about a second.",
    "- Talks to the API only through `@wheelhouse/api-client`, which sends the CSRF token and turns a failed call into an ApiError with `fields` (what to fix) and `current` (the row as it is now, for an optimistic-lock conflict).",
  ].join("\n"),
  interfaces:
    "PWA: apps/web/public/manifest.webmanifest and sw.js (registered by components/pwa.tsx in production builds only); /offline.html is the static fallback. Built by Vite to apps/web/dist, which the API serves on its own port and origin, so there is no CORS. Development: Vite on 5173 proxies /api and /mcp to the API (VITE_API_TARGET).",
  gotchas:
    "The service worker caches only /assets/* and /offline.html. It must never cache /api, /mcp, page navigations (the HTML is user-specific) or non-GET requests. jsdom cannot drive dnd-kit or React Flow's edges, so a drag on the board and the map's edges are checked in a real browser. The GitHub integration page (Settings → Integrations → GitHub, apps/web/src/pages/integrations) has a Connect GitHub card that leaves the app for GitHub and comes back through the API's callback.",
};

const API = {
  summary: "NestJS API: /mcp, /api/v1, /api/app, the GitHub webhook and the live streams; also serves the React build",
  purpose:
    "Everything that is not a screen, in one process on one port: the plugin, the CLI, the GitHub App and the React app all reach the same server, at the same paths the Next app served. Controllers are thin: they read the request and call @wheelhouse/core, and never touch the database.",
  responsibilities: [
    "- MCP (POST /mcp) and REST (/api/v1/<tool>) over the same tool registry, authenticated by API key.",
    "- The web app's JSON API (/api/app/*): session cookie, CSRF check (ADR-18), one error envelope.",
    "- GitHub: the webhook, and the install and callback of the Connect GitHub flow (ADR-12).",
    "- Live updates: /api/stream and /api/teams/:key/stream over SSE.",
    "- /api/health, and the built React app with a fallback to its shell for any page address.",
  ].join("\n"),
  interfaces:
    "Public paths are frozen and unchanged: /mcp, /api/v1/*, /api/webhooks/github, /api/github/install, /api/github/callback, /api/stream, /api/health (the team stream was /api/projects/:key/stream until WH-112). /api/app/* is the web app's own API (docs/ui-api.md).",
  gotchas:
    "A controller must not call the database: the isolation audit fails any getDb() under apps/api/src, and every /api/app route needs an entry in API_ROUTE_AUDIT. It runs from source with tsx, as PID 1 in the image (ADR-17). One replica only: migrations run at boot and the live-update bus is in process.",
};

const CORE = {
  summary: "@wheelhouse/core: schema, migrations, the service layer and the framework-free libraries",
  purpose:
    "The product's rules in a package that knows nothing about HTTP, Next, Nest or React: the Drizzle schema and its frozen migrations, the service layer that is the one write path, the tool registry, the GitHub integration, sync and freshness, and the libraries both apps use. Both the API and the React app import from it; neither can drift from the other.",
  gotchas:
    "Must not import next/*, react, server-only or anything from the apps; a check enforces it. Schema changes need a migration (CI fails otherwise) and, during the migration, an agreement first. A version check that reads, compares and writes must lock the row (SELECT ... FOR UPDATE): see the decision on versioned edits.",
};

const MODULES: { name: string; summary: string; anchors: string[]; implements?: string }[] = [
  { name: "Web app API", summary: "/api/app: the JSON endpoints behind every page, with session auth and CSRF", anchors: ["apps/api/src/web/**"] },
  { name: "GitHub webhook and connect", summary: "The signed webhook, and the install and callback of the Connect GitHub flow", anchors: ["apps/api/src/github/**"], implements: "Repository connection" },
  { name: "Live streams", summary: "Server-sent events for a team and for a workspace, with a heartbeat and a cap per person", anchors: ["apps/api/src/stream/**"] },
];

const EDGES: { from: string; to: string; label?: string; kind?: "depends" | "implements"; remove?: boolean }[] = [
  { from: "web", to: "API", label: "JSON over HTTP (/api/app)" },
  { from: "API", to: "core", label: "calls" },
  { from: "core", to: "Postgres", label: "SQL" },
  { from: "web", to: "Postgres", remove: true },
  { from: "Board UI", to: "Web app API", label: "/api/app" },
  { from: "Board UI", to: "Service layer", remove: true },
  { from: "Map UI", to: "Web app API", label: "/api/app" },
  { from: "Map UI", to: "Service layer", remove: true },
  { from: "Web app API", to: "Service layer", label: "service functions" },
  { from: "Web app API", to: "Claude API", label: "Ask the map" },
  { from: "Map UI", to: "Claude API", remove: true },
  { from: "GitHub", to: "GitHub webhook and connect", label: "webhooks" },
  { from: "GitHub webhook and connect", to: "Service layer", label: "land changes" },
  { from: "GitHub", to: "Service layer", remove: true },
];

const TERMS = [
  { term: "Contract suite", definition: "The black-box HTTP tests that freeze what the plugin, the CLI, the GitHub App and the web app rely on (/mcp, /api/v1, the webhook, the streams, /api/app). They run against the Next app, the Nest API and the packaged image." },
  { term: "Core", definition: "@wheelhouse/core: the package holding the schema, the service layer and the libraries shared by the API and the React app." },
];

const ADR_16_NOTE = (date: string) =>
  `\n\nImplemented (${date}): the contract suite (311 tests) and the existing tests pass on the new app, which runs from one image where the API serves the React build (WH-88 to WH-100). The data was moved by an exact export and import, rehearsed four times on copies of the real data, and the app now runs on the imported copy at the same URL, so the plugin, the CLI and existing keys needed no change. What remains is removing the Next app from the repository (WH-102), which waits until the new app has run in earnest.`;

const NEW_ADRS = [
  {
    title: "The React app is served by the API process: one image, one port, one origin",
    status: "accepted" as const,
    context:
      "The packaging ticket (WH-99) had to choose between the API serving the React build, or the proxy (Caddy) serving it and forwarding only /api and /mcp. The Next app was one container on one port, and the plugin, the GitHub App and the session cookie all assume one address.",
    decision:
      "The API serves apps/web/dist itself (apps/api/src/web-static.ts): files as they are, hashed assets cached for a year, the shell, sw.js and the manifest never cached, any other non-API GET answered with the shell, a missing file with an extension a plain 404, and /api and /mcp never touched. One image holds the API and the build; the proxy only forwards. The image runs node as PID 1 with tsx, as a non-root user.",
    consequences:
      "One container to deploy, one origin (no CORS, and the CSRF origin check and the session cookie see one host), and the same health check as before. The proxy needs only the SSE settings (no buffering, no compression for the two stream paths). The web app and the API cannot be scaled or deployed separately; that is not needed at this size and would need CORS thought (ADR-18). While the Next app is in the repository its dependencies still inflate the image.",
    nodes: ["API", "web"],
  },
  {
    title: "A versioned edit locks the row it checks",
    status: "accepted" as const,
    context:
      "Tickets, docs, map nodes, flows and decisions carry a version, and an edit made from a stale version must be refused. The check read the row, compared the version and wrote, with nothing stopping two edits from reading the same version before either wrote. The in-process test database runs one transaction at a time, so every test passed; on Postgres, which is what runs in production, two simultaneous edits from the same version were both applied and one silently replaced the other. The contract suite run against the packaged image on a real Postgres found it. The old app had the same flaw for tickets and docs.",
    decision:
      "Inside the transaction, the row is selected FOR UPDATE and read again before its version is compared, so a second edit waits for the first to commit and then sees the new version and is refused as a conflict. A regression test races two edits per entity on a real Postgres in CI (version-lock.test.ts) and fails without the lock.",
    consequences:
      "Concurrent edits from the same version give exactly one success and one conflict on both engines. Edits wait on each other for the length of one short transaction. Any new versioned entity must take the lock the same way, and its test belongs in version-lock.test.ts.",
    nodes: ["Service layer", "core"],
  },
];

/** Run the whole update as `owner`'s workspace's human actor. */
export async function postMigrationMap(): Promise<Outcome> {
  const out: Outcome = { did: [], skipped: [] };
  const db = await getDb();
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.key, TEAM));
  if (!team) throw new Error(`no team ${TEAM} in this database`);
  const [owner] = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.workspaceId, team.workspaceId), eq(schema.memberships.role, "owner")))
    .orderBy(asc(schema.memberships.createdAt))
    .limit(1);
  if (!owner) throw new Error("the team's workspace has no owner to act as");
  const actor: Actor = { kind: "human", id: owner.id, name: owner.name, workspaceId: team.workspaceId };

  const node = async (name: string, layer?: schema.Layer) => (await svc.getGraph(actor, TEAM)).nodes.find((n) => n.name === name && (!layer || n.layer === layer));
  const note = (did: string) => out.did.push(did);

  // Nodes: the web app, the API, core and the API's modules.
  const web = await node("web", "system");
  if (!web) out.skipped.push('no system node "web"; nothing to rewrite');
  else if (web.summary !== WEB.summary || web.responsibilities !== WEB.responsibilities) {
    await svc.upsertNode(actor, TEAM, { id: web.id, ...WEB, forcePublish: true });
    note('web: described as the React app');
  }
  for (const [name, spec, anchors] of [["API", API, ["apps/api/**"]], ["core", CORE, ["packages/core/**"]]] as const) {
    const existing = await node(name, "system");
    const before = existing ? JSON.stringify([existing.summary, existing.purpose, existing.gotchas]) : "";
    await svc.upsertNode(actor, TEAM, { name, layer: "system", kind: name === "API" ? "service" : "module", status: "live", anchors: [...anchors], ...spec, forcePublish: true });
    if (!existing) note(`${name}: added`);
    else if (before !== JSON.stringify([spec.summary, spec.purpose, spec.gotchas])) note(`${name}: updated`);
  }
  for (const m of MODULES) {
    const existing = await node(m.name, "system");
    await svc.upsertNode(actor, TEAM, { name: m.name, layer: "system", kind: "module", parent: "API", summary: m.summary, anchors: m.anchors, status: "live", forcePublish: true });
    if (!existing) note(`${m.name}: added under API`);
    if (m.implements) await svc.upsertEdge(actor, TEAM, { from: m.name, to: m.implements, kind: "implements" }).catch((e) => out.skipped.push(`${m.name} implements ${m.implements}: ${e.message}`));
  }

  // Where things now live.
  for (const [name, parent] of [["MCP server", "API"], ["Service layer", "core"]] as const) {
    const n = await node(name, "system");
    if (!n) out.skipped.push(`no system node "${name}"`);
    else if (n.parentId !== (await node(parent, "system"))?.id) {
      await svc.upsertNode(actor, TEAM, { id: n.id, parent, forcePublish: true });
      note(`${name}: now inside ${parent}`);
    }
  }
  const mcp = await node("MCP server", "system");
  if (mcp && mcp.details.includes("src/app/mcp/route.ts")) {
    await svc.upsertNode(actor, TEAM, { id: mcp.id, details: "- `apps/api/src/mcp/mcp.controller.ts` (the route)\n- tools in `packages/core/src/lib/tools.ts`, shared with /api/v1", forcePublish: true });
    note("MCP server: details point at the Nest controller");
  }
  const service = await node("Service layer", "system");
  if (service) {
    const patch: Record<string, string> = {};
    if (service.interfaces.includes("Called by UI server actions, the REST API and the MCP server")) patch.interfaces = service.interfaces.replace("Called by UI server actions, the REST API and the MCP server", "Called by the web app's API (/api/app), the REST API and the MCP server");
    if (service.gotchas.includes("Never write to the DB from routes directly")) patch.gotchas = service.gotchas.replace("Never write to the DB from routes directly", "Never write to the DB from controllers or routes directly");
    if (!service.responsibilities.includes("FOR UPDATE")) patch.responsibilities = `${service.responsibilities}\n- A versioned edit locks the row it checks (SELECT ... FOR UPDATE), so two edits from the same version give one success and one conflict`.trim();
    if (Object.keys(patch).length) {
      await svc.upsertNode(actor, TEAM, { id: service.id, ...patch, forcePublish: true });
      note(`Service layer: ${Object.keys(patch).join(", ")}`);
    }
  }
  const board = await node("Board UI", "system");
  if (board) {
    const marker = "Server actions in src/app/actions.ts (createTicketAction, moveTicketAction, ...).";
    const field = (["interfaces", "details", "gotchas", "responsibilities", "purpose"] as const).find((f) => board[f].includes(marker));
    if (field) {
      await svc.upsertNode(actor, TEAM, { id: board.id, [field]: board[field].replace(marker, "Calls the API through @wheelhouse/api-client (api.tickets.*, api.teams.board, ...), which sends the CSRF token and reports a stale version as a conflict."), forcePublish: true });
      note("Board UI: no longer says server actions");
    }
  }
  const lib = await node("src/lib", "code");
  if (lib) {
    await svc.upsertNode(actor, TEAM, { id: lib.id, name: "packages/core/src/lib", forcePublish: true });
    note("src/lib: renamed to packages/core/src/lib");
  }

  // Connections.
  const graph = await svc.getGraph(actor, TEAM);
  const byName = new Map(graph.nodes.map((n) => [`${n.name}`, n]));
  for (const e of EDGES) {
    const from = byName.get(e.from);
    const to = byName.get(e.to);
    if (!from || !to) {
      if (!e.remove) out.skipped.push(`edge ${e.from} -> ${e.to}: a node is missing`);
      continue;
    }
    const kind = e.kind ?? "depends";
    const existing = graph.edges.find((x) => x.fromNodeId === from.id && x.toNodeId === to.id && x.kind === kind);
    if (e.remove) {
      if (existing) {
        await svc.deleteEdge(actor, TEAM, existing.id);
        note(`edge ${e.from} -> ${e.to} removed`);
      }
    } else if (!existing || existing.label !== (e.label ?? existing.label)) {
      await svc.upsertEdge(actor, TEAM, { from: e.from, to: e.to, label: e.label, kind });
      note(`edge ${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ""}`);
    }
  }

  // The flow that said "Server action".
  const flow = graph.flows.find((f) => f.name === "Agent picks up a ticket");
  const step = flow?.steps.find((s) => s.title === "Server action calls moveTicket");
  if (flow && step) {
    const steps = flow.steps.map((s) => ({ node: s.nodeId, title: s === step ? "The web app calls the API, which calls moveTicket" : s.title, detail: s.detail ?? "" }));
    await svc.upsertFlow(actor, TEAM, { id: flow.id, name: flow.name, description: flow.description ?? "", steps });
    note('flow "Agent picks up a ticket": step 2 names the API');
  }

  // The glossary.
  const terms = await svc.listTerms(actor, TEAM);
  for (const t of TERMS) {
    if (!terms.some((x) => x.term === t.term && x.definition === t.definition)) {
      await svc.upsertTerm(actor, TEAM, t);
      note(`term "${t.term}"`);
    }
  }

  // Decisions.
  const decisions = await svc.listDecisions(actor, TEAM);
  const adr16 = decisions.find((d) => d.title.startsWith("Migrate from Next.js to NestJS + React"));
  if (adr16 && !adr16.consequences.includes("Implemented (")) {
    await svc.upsertDecision(actor, TEAM, { number: adr16.number, consequences: adr16.consequences + ADR_16_NOTE(new Date().toISOString().slice(0, 10)) });
    note(`ADR-${adr16.number}: recorded as implemented`);
  } else if (!adr16) out.skipped.push("no ADR about the migration to NestJS + React");
  const adr17 = decisions.find((d) => d.title.startsWith("The API is an ESM NestJS app run with tsx"));
  const sentence = "production packaging (WH-99) must either bundle it with esbuild or keep running tsx";
  if (adr17?.consequences.includes(sentence)) {
    await svc.upsertDecision(actor, TEAM, { number: adr17.number, consequences: adr17.consequences.replace(sentence, "production packaging (WH-99) keeps running tsx: the image starts it as `node --import tsx src/main.ts`, with node as PID 1") });
    note(`ADR-${adr17.number}: packaging settled`);
  }
  for (const adr of NEW_ADRS) {
    if (!decisions.some((d) => d.title === adr.title)) {
      const made = await svc.upsertDecision(actor, TEAM, adr);
      note(`ADR-${made.number}: ${adr.title}`);
    }
  }
  return out;
}
