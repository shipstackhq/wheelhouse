import "server-only";
import { z } from "zod";
import type { Actor } from "./auth";
import * as svc from "./service";
import * as sync from "./sync";
import { PRIORITIES, NODE_KINDS, LAYERS, KINDS_BY_LAYER, EDGE_KINDS, DECISION_STATUSES } from "@/db/schema";

/**
 * One registry of operations, exposed both as MCP tools (/mcp) and as
 * REST endpoints (POST /api/v1/<tool>). Keep descriptions agent-oriented:
 * they're what Claude reads to decide how to use Wheelhouse.
 */

type Tool<S extends z.ZodType> = {
  description: string;
  input: S;
  readOnly?: boolean;
  /** Not listed over MCP (client/CLI plumbing); still callable via REST. */
  hidden?: boolean;
  run: (actor: Actor, args: z.infer<S>) => Promise<unknown>;
};
const tool = <S extends z.ZodType>(t: Tool<S>) => t;

const project = z.string().describe('Project key (e.g. "WH") or id');
const ticket = z.string().describe('Ticket ref like "WH-12" (or id)');
const expectedVersion = z
  .number()
  .int()
  .optional()
  .describe("Ticket version you last read. If the team changed it since, the call fails with a conflict instead of overwriting their edit.");

export const tools = {
  list_projects: tool({
    description: "List projects (boards) in your team.",
    input: z.object({}),
    readOnly: true,
    run: (a) => svc.listProjects(a),
  }),

  create_project: tool({
    description: "Create a project with default columns: Backlog, Todo, In Progress, Review, Done.",
    input: z.object({ name: z.string(), key: z.string().max(6).optional(), description: z.string().optional() }),
    run: (a, i) => svc.createProject(a, i),
  }),

  get_board: tool({
    description: "Get the kanban board: columns in order, each with its tickets (ref, title, priority, labels, version, claimable/claimed, linked graph nodes).",
    input: z.object({ project }),
    readOnly: true,
    run: async (a, i) => {
      const b = await svc.getBoard(a, i.project);
      return {
        project: { key: b.project.key, name: b.project.name, description: b.project.description },
        columns: b.columns.map((c) => ({
          name: c.name,
          tickets: b.tickets
            .filter((t) => t.columnId === c.id)
            .map((t) => ({
              ref: t.ref,
              title: t.title,
              priority: t.priority,
              labels: t.labels,
              version: t.version,
              agentClaimable: t.agentClaimable,
              claimed: !!t.claimedByKeyId,
              comments: t.commentCount,
              linkedNodes: t.nodeIds.length,
            })),
        })),
      };
    },
  }),

  get_ticket: tool({
    description: "Full ticket: description (markdown), comments thread with the team, linked architecture nodes, and change history.",
    input: z.object({ ticket }),
    readOnly: true,
    run: (a, i) => svc.getTicket(a, i.ticket),
  }),

  create_ticket: tool({
    description: "Create a ticket. Use for work you discover or plan. Body is markdown — include acceptance criteria.",
    input: z.object({
      project,
      title: z.string(),
      body: z.string().optional(),
      column: z.string().optional().describe("Column name, default Backlog"),
      priority: z.enum(PRIORITIES).optional(),
      labels: z.array(z.string()).optional(),
      link_nodes: z.array(z.string()).optional().describe("Graph node names/ids this ticket touches"),
    }),
    run: async (a, i) => {
      const t = await svc.createTicket(a, i.project, { ...i, column: i.column });
      for (const n of i.link_nodes ?? []) await svc.linkTicketNode(a, t.ref, n);
      return t;
    },
  }),

  update_ticket: tool({
    description: "Edit ticket fields. Only the fields you pass change.",
    input: z.object({
      ticket,
      title: z.string().optional(),
      body: z.string().optional(),
      priority: z.enum(PRIORITIES).optional(),
      labels: z.array(z.string()).optional(),
      expected_version: expectedVersion,
    }),
    run: (a, { ticket, expected_version, ...patch }) => svc.updateTicket(a, ticket, patch, expected_version),
  }),

  move_ticket: tool({
    description: 'Move a ticket to a column (e.g. "In Progress" when you start, "Review" when done — leave "Done" for humans unless told otherwise).',
    input: z.object({
      ticket,
      column: z.string(),
      index: z.number().int().optional().describe("Position in column, default end"),
      expected_version: expectedVersion,
    }),
    run: (a, i) => svc.moveTicket(a, i.ticket, i.column, i.index, i.expected_version),
  }),

  claim_ticket: tool({
    description: "Claim an agent-claimable ticket before working on it, so other agents skip it.",
    input: z.object({ ticket }),
    run: (a, i) => svc.claimTicket(a, i.ticket),
  }),

  comment: tool({
    description: "Post a comment on a ticket. This is how you talk to the team: questions, progress notes, decisions, what you changed.",
    input: z.object({ ticket, body: z.string().describe("Markdown") }),
    run: (a, i) => svc.addComment(a, i.ticket, i.body),
  }),

  get_changes: tool({
    description:
      "YOUR QUEUE. Changes the team (and other agents) made since you last acknowledged: tickets created/edited/moved/reprioritized, comments addressed to you, map edits; plus staleNodes (map nodes whose code changed). Check at the start of every task and act on them, then call ack_changes with the highest seq you handled. Returns at most `limit` (default 50) oldest changes; when there are more you also get a summary and latestSeq so you can catch up without replaying everything.",
    input: z.object({ project, limit: z.number().int().optional() }),
    readOnly: true,
    run: (a, i) => svc.getChanges(a, i.project, i.limit),
  }),

  ack_changes: tool({
    description: "Mark queue changes up to and including `seq` as handled.",
    input: z.object({ project, seq: z.number().int() }),
    run: (a, i) => svc.ackChanges(a, i.project, i.seq),
  }),

  get_activity: tool({
    description: "Recent activity feed for a project (newest first), by both humans and agents.",
    input: z.object({ project, limit: z.number().int().optional() }),
    readOnly: true,
    run: (a, i) => svc.listEvents(a, i.project, { limit: i.limit ?? 30 }),
  }),

  // ───────── knowledge map ─────────

  get_graph: tool({
    description:
      'The knowledge map. Four linked layers: "concept" (what the product does), "system" (services/modules/datastores and how they talk), "data" (tables/views/enums and their relationships; use get_schema for columns), "code" (directories/files/symbols/endpoints). Nodes nest via parentId within a layer; edges are "depends" (within a layer), "implements" (lower layer → the higher-level node it realizes) or "references" (table → table foreign keys). Also lists flows, decisions and glossary terms by name. Pass `layer` to fetch one layer. Read this before structural work; use get_node for one node in full.',
    input: z.object({ project, layer: z.enum(LAYERS).optional() }),
    readOnly: true,
    run: async (a, i) => {
      const g = await svc.getGraph(a, i.project);
      const ns = i.layer ? g.nodes.filter((n) => n.layer === i.layer) : g.nodes;
      const ids = new Set(ns.map((n) => n.id));
      return {
        nodes: ns.map((n) => ({
          id: n.id,
          layer: n.layer,
          parentId: n.parentId,
          kind: n.kind,
          name: n.name,
          summary: n.summary,
          status: n.status,
          anchors: n.anchors,
          stale: n.stale || undefined,
        })),
        edges: g.edges
          .filter((e) => ids.has(e.fromNodeId) || ids.has(e.toNodeId))
          .map(({ id, kind, fromNodeId, toNodeId, label }) => ({ id, kind, from: fromNodeId, to: toNodeId, label: label || undefined })),
        flows: g.flows.map((f) => ({ name: f.name, steps: f.steps.length })),
        decisions: g.decisions.map((d) => ({ number: d.number, title: d.title, status: d.status })),
        terms: g.terms.map((t) => t.term),
      };
    },
  }),

  get_node: tool({
    description:
      'One node in full: its structured explainer (purpose, responsibilities, interfaces, gotchas, notes), code anchors, freshness, parent/children, depends-on/used-by, what it implements / is implemented by (across layers), flows it appears in, decisions and tickets. Node refs are a name, an id, or "layer:name" when a name exists on several layers.',
    input: z.object({ project, node: z.string() }),
    readOnly: true,
    run: (a, i) => svc.getNode(a, i.project, i.node),
  }),

  upsert_node: tool({
    description: `Create or update a map node (matched by \`id\`, else by name within \`layer\`). Only fields you pass change.
Layers & kinds — concept: ${KINDS_BY_LAYER.concept.join("/")}; system: ${KINDS_BY_LAYER.system.join("/")}; data: ${KINDS_BY_LAYER.data.join("/")} (prefer upsert_table, which also takes columns); code: ${KINDS_BY_LAYER.code.join("/")}.
Write for a teammate who hasn't read the code: \`summary\` one line; \`purpose\` why it exists; \`responsibilities\` bullets of what it owns; \`interfaces\` its inputs/outputs/APIs/events; \`gotchas\` invariants and traps. \`anchors\` are repo paths or globs this node describes (e.g. "src/lib/service.ts", "src/app/mcp/**") — they power staleness detection, so set them on system and code nodes. Updating any explainer field (or passing mark_fresh) clears the stale flag; pass described_sha (git rev-parse HEAD) when you've just re-read the code.
\`implements\`: names of higher-layer nodes this one realizes (code → data → system → concept).`,
    input: z.object({
      project,
      name: z.string(),
      id: z.string().optional(),
      layer: z.enum(LAYERS).optional().describe("Default system (or the parent's layer)"),
      kind: z.enum(NODE_KINDS).optional(),
      parent: z.string().nullable().optional().describe("Parent node (same layer) name or id; null moves to top level"),
      summary: z.string().optional(),
      purpose: z.string().optional(),
      responsibilities: z.string().optional(),
      interfaces: z.string().optional(),
      gotchas: z.string().optional(),
      details: z.string().optional().describe("Free-form notes (markdown)"),
      status: z.enum(["planned", "building", "live", "deprecated"]).optional(),
      anchors: z.array(z.string()).optional(),
      implements: z.array(z.string()).optional(),
      described_sha: z.string().optional(),
      mark_fresh: z.boolean().optional(),
    }),
    run: (a, { project, described_sha, mark_fresh, ...n }) =>
      svc.upsertNode(a, project, { ...n, describedSha: described_sha, markFresh: mark_fresh }),
  }),

  delete_node: tool({
    description: "Delete a node and everything nested in it.",
    input: z.object({ project, node: z.string() }),
    run: (a, i) => svc.deleteNode(a, i.project, i.node),
  }),

  upsert_edge: tool({
    description:
      'Connect two nodes. kind "depends" (default): from uses/calls to, same layer, e.g. "web" → "api" label "REST". kind "implements": from a LOWER layer to the HIGHER-level node it realizes, e.g. code "src/lib/service.ts" implements system "Service layer", system "Service layer" implements concept "AI change queue".',
    input: z.object({ project, from: z.string(), to: z.string(), kind: z.enum(EDGE_KINDS).optional(), label: z.string().optional() }),
    run: (a, { project, ...e }) => svc.upsertEdge(a, project, e),
  }),

  unlink_nodes: tool({
    description: "Remove the edge(s) between two nodes (optionally only one kind).",
    input: z.object({ project, from: z.string(), to: z.string(), kind: z.enum(EDGE_KINDS).optional() }),
    run: (a, { project, ...e }) => svc.unlinkNodes(a, project, e),
  }),

  link_ticket_node: tool({
    description: "Link (or unlink) a ticket to a map node it touches.",
    input: z.object({ ticket, node: z.string(), unlink: z.boolean().optional() }),
    run: (a, i) => svc.linkTicketNode(a, i.ticket, i.node, i.unlink),
  }),

  get_schema: tool({
    description:
      "The data model from the map's data layer: every table/view/enum with its columns (type, pk, nullable, unique, default, FK target), indexes, what it implements, and all relationships with cardinality. Read before changing the schema or writing queries.",
    input: z.object({ project }),
    readOnly: true,
    run: (a, i) => svc.getSchema(a, i.project),
  }),

  upsert_table: tool({
    description: `Create or update a table, view or enum on the data layer (matched by name), with its full column list. Columns replace the previous list wholesale, so always send every column.
Foreign keys: set a column's \`references\` to "table.column" (e.g. "projects.id") and the relationship edge is drawn automatically, with cardinality n-1 (1-1 when the FK column is unique or the sole primary key). Targets that don't exist yet are returned as \`unresolved\`; they link up once you upsert those tables, so order doesn't matter.
For enums, list each value as a column (name only). Set \`anchors\` to the schema/migration file(s) defining it (append "#name" to point at the definition), and \`implements\` to the concept(s) it stores and the system database it lives in.`,
    input: z.object({
      project,
      name: z.string(),
      kind: z.enum(["table", "view", "enum"]).optional(),
      summary: z.string().optional(),
      purpose: z.string().optional(),
      gotchas: z.string().optional().describe("Invariants, soft-delete rules, denormalisations, hot paths"),
      columns: z
        .array(
          z.object({
            name: z.string(),
            type: z.string().describe('SQL type as written, e.g. "uuid", "text", "timestamptz", "jsonb"'),
            pk: z.boolean().optional(),
            nullable: z.boolean().optional(),
            unique: z.boolean().optional(),
            default: z.string().optional(),
            references: z.string().optional().describe('"table.column"'),
            onDelete: z.string().optional().describe("cascade | set null | restrict | no action"),
            note: z.string().optional(),
          }),
        )
        .describe("All columns, in schema order"),
      indexes: z.array(z.object({ name: z.string().optional(), columns: z.array(z.string()), unique: z.boolean().optional() })).optional(),
      anchors: z.array(z.string()).optional(),
      implements: z.array(z.string()).optional(),
      described_sha: z.string().optional(),
    }),
    run: async (a, { project, described_sha, ...t }) => {
      const node = await svc.upsertNode(a, project, { ...t, layer: "data", describedSha: described_sha });
      const { unresolved } = await svc.syncReferences(a, project);
      return { table: { id: node.id, name: node.name, kind: node.kind, columns: node.columns.length }, unresolved };
    },
  }),

  get_briefing: tool({
    description:
      "START HERE in a new session. A compact briefing of the project: what it is, how it's built, the work in flight (yours first), what changed since you last looked, decisions/gotchas/stale and in-flux areas, flows and glossary. Overview with pointers, sized to a budget. Read this instead of exploring the codebase from scratch.",
    readOnly: true,
    input: z.object({ project, max_chars: z.number().int().optional().describe("Default 6000") }),
    run: async (a, i) => (await import("./briefing")).briefing(a, i.project, { maxChars: i.max_chars }),
  }),

  get_ticket_context: tool({
    description:
      "Everything you need to work one ticket: description and discussion, the parts of the system it touches (with explanations and gotchas), what they connect to on other layers, which files to read first, tables involved, flows passing through, and decisions that apply. Call this before starting a ticket instead of searching the repo.",
    readOnly: true,
    input: z.object({ ticket, max_chars: z.number().int().optional().describe("Default 8000") }),
    run: async (a, i) => (await import("./briefing")).ticketContext(a, i.ticket, { maxChars: i.max_chars }),
  }),

  // ───────── sync plumbing (used by the wheelhouse CLI / hooks) ─────────

  session_sync: tool({
    description: "CLI: record files a client session touched (optionally with content hashes).",
    hidden: true,
    input: z.object({
      project,
      session: z.string(),
      client: z.string().optional(),
      branch: z.string().optional(),
      files: z.union([z.array(z.string()), z.record(z.string(), z.string().nullable())]).optional(),
      external: z.boolean().optional(),
    }),
    run: (a, { project, ...r }) => sync.sessionSync(a, project, r),
  }),

  session_status: tool({
    description: "CLI: what a session still owes (ticket update, map updates) before ending a turn.",
    hidden: true,
    readOnly: true,
    input: z.object({ project, session: z.string() }),
    run: (a, i) => sync.sessionStatus(a, i.project, i.session),
  }),

  session_end: tool({
    description: "CLI: mark a session ended.",
    hidden: true,
    input: z.object({ project, session: z.string() }),
    run: (a, i) => sync.sessionEnd(a, i.project, i.session),
  }),

  land_changes: tool({
    description: "CLI/git hook: files landed on the default branch with their content hashes (null = deleted). baseline=true records hashes without flagging.",
    hidden: true,
    input: z.object({
      project,
      sha: z.string().optional(),
      branch: z.string().optional(),
      baseline: z.boolean().optional(),
      files: z.record(z.string(), z.string().nullable()),
    }),
    run: (a, { project, ...r }) => sync.land(a, project, r),
  }),

  list_drafts: tool({
    description: "Pending map drafts: explanation updates written against code that hasn't landed on the default branch yet. They publish automatically when it lands.",
    readOnly: true,
    input: z.object({ project }),
    run: (a, i) => sync.listDrafts(a, i.project),
  }),

  get_flows: tool({
    description: "Flows (ordered walkthroughs across nodes) with their steps. Pass `name` for one flow.",
    input: z.object({ project, name: z.string().optional() }),
    readOnly: true,
    run: async (a, i) => {
      const g = await svc.getGraph(a, i.project);
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      return g.flows
        .filter((f) => !i.name || f.name.toLowerCase() === i.name.toLowerCase())
        .map((f) => ({
          name: f.name,
          description: f.description,
          steps: f.steps.map((s, idx) => {
            const n = byId.get(s.nodeId);
            return { step: idx + 1, node: n ? `${n.layer}:${n.name}` : null, title: s.title, detail: s.detail };
          }),
        }));
    },
  }),

  upsert_flow: tool({
    description:
      'Create or replace a flow: a named walk through the map that explains how something works end to end, e.g. "Agent picks up a ticket" or "User signs up". 3–10 steps; each step names a node (name, id or "layer:name") with a short title and a 1–2 sentence detail. Steps are replaced wholesale. Flows are the single best way to explain a system — add them for the key paths.',
    input: z.object({
      project,
      name: z.string(),
      description: z.string().optional(),
      steps: z.array(z.object({ node: z.string(), title: z.string(), detail: z.string().optional() })).optional(),
    }),
    run: (a, { project, ...f }) => svc.upsertFlow(a, project, f),
  }),

  delete_flow: tool({
    description: "Delete a flow by name or id.",
    input: z.object({ project, flow: z.string() }),
    run: (a, i) => svc.deleteFlow(a, i.project, i.flow),
  }),

  report_changes: tool({
    description:
      "Report files you changed (after finishing a ticket, or from a git hook). Map nodes whose anchors most specifically match those files are flagged stale so their explanations get refreshed. Returns which nodes were flagged and which files no node anchors (consider adding anchors or nodes for them).",
    input: z.object({
      project,
      files: z.array(z.string()).min(1).describe("Repo-relative paths"),
      sha: z.string().optional().describe("Commit sha the changes landed in"),
      summary: z.string().optional(),
    }),
    run: (a, { project, ...r }) => svc.reportChanges(a, project, r),
  }),

  get_stale_nodes: tool({
    description: "Map nodes flagged stale (their code changed since they were described), with the reason and anchors to re-read.",
    input: z.object({ project }),
    readOnly: true,
    run: (a, i) => svc.listStale(a, i.project),
  }),

  mark_fresh: tool({
    description: "Clear a node's stale flag after confirming its explanation is still accurate (no edits needed).",
    input: z.object({ project, node: z.string(), sha: z.string().optional() }),
    run: (a, i) => svc.markFresh(a, i.project, i.node, i.sha),
  }),

  list_decisions: tool({
    description: "Architecture decision records (ADRs) for the project.",
    input: z.object({ project }),
    readOnly: true,
    run: (a, i) => svc.listDecisions(a, i.project),
  }),

  upsert_decision: tool({
    description:
      'Record (omit number) or update (pass number) an ADR: the WHY behind a non-obvious choice, e.g. "Use 303 not 307 for auth redirects". Keep context/decision/consequences to a few sentences each and attach the nodes it applies to. Record one whenever you make a choice a teammate might later question or undo.',
    input: z.object({
      project,
      number: z.number().int().optional(),
      title: z.string().optional(),
      status: z.enum(DECISION_STATUSES).optional(),
      context: z.string().optional(),
      decision: z.string().optional(),
      consequences: z.string().optional(),
      nodes: z.array(z.string()).optional(),
    }),
    run: (a, { project, ...d }) => svc.upsertDecision(a, project, d),
  }),

  list_terms: tool({
    description: "The project glossary (domain terms and definitions).",
    input: z.object({ project }),
    readOnly: true,
    run: (a, i) => svc.listTerms(a, i.project),
  }),

  upsert_term: tool({
    description: "Define or update a glossary term (project-specific vocabulary a newcomer wouldn't know). Optionally link the concept node it names.",
    input: z.object({ project, term: z.string(), definition: z.string(), node: z.string().nullable().optional() }),
    run: (a, { project, ...t }) => svc.upsertTerm(a, project, t),
  }),

  delete_term: tool({
    description: "Remove a glossary term.",
    input: z.object({ project, term: z.string() }),
    run: (a, i) => svc.deleteTerm(a, i.project, i.term),
  }),

};

export type ToolName = keyof typeof tools;

export function listToolDefs(opts: { includeHidden?: boolean } = {}) {
  return Object.entries(tools as Record<string, Tool<z.ZodType>>)
    .filter(([, t]) => opts.includeHidden || !t.hidden)
    .map(([name, t]) => {
    const { $schema: _s, ...inputSchema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    void _s;
    return {
      name,
      description: t.description,
      inputSchema,
      annotations: { readOnlyHint: !!t.readOnly },
    };
  });
}

export async function runTool(actor: Actor, name: string, rawArgs: unknown) {
  const t = (tools as Record<string, Tool<z.ZodType>>)[name];
  if (!t) throw new svc.ServiceError("not_found", `Unknown tool ${name}`);
  const parsed = t.input.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new svc.ServiceError("invalid", z.prettifyError(parsed.error));
  return t.run(actor, parsed.data);
}
