import "server-only";
import { z } from "zod";
import type { Actor } from "./auth";
import * as svc from "./service";
import { PRIORITIES, NODE_KINDS } from "@/db/schema";

/**
 * One registry of operations, exposed both as MCP tools (/mcp) and as
 * REST endpoints (POST /api/v1/<tool>). Keep descriptions agent-oriented:
 * they're what Claude reads to decide how to use Wheelhouse.
 */

type Tool<S extends z.ZodType> = {
  description: string;
  input: S;
  readOnly?: boolean;
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
      "YOUR QUEUE. Changes the team (and other agents) made since you last acknowledged: tickets created/edited/moved/reprioritized, comments addressed to you, architecture edits. Check at the start of every task and act on them, then call ack_changes with the highest seq you handled.",
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

  get_graph: tool({
    description:
      "The architecture map: nodes (services containing nested modules/components via parentId), edges between them, and which tickets touch each node. Read before making structural changes.",
    input: z.object({ project }),
    readOnly: true,
    run: async (a, i) => {
      const g = await svc.getGraph(a, i.project);
      return {
        nodes: g.nodes.map(({ id, parentId, kind, name, summary, details, status }) => ({ id, parentId, kind, name, summary, details, status })),
        edges: g.edges.map(({ id, fromNodeId, toNodeId, label }) => ({ id, from: fromNodeId, to: toNodeId, label })),
        ticketLinks: g.ticketLinks.map(({ nodeId, ref, title }) => ({ nodeId, ref, title })),
      };
    },
  }),

  upsert_node: tool({
    description:
      "Create or update an architecture node (matched by `id`, else by exact name). Top-level nodes are big services/apps; set `parent` to nest modules inside them. Keep `summary` to one line; put responsibilities, key files, interfaces and gotchas in `details` (markdown) so humans get the picture without reading code.",
    input: z.object({
      project,
      name: z.string(),
      id: z.string().optional(),
      kind: z.enum(NODE_KINDS).optional(),
      parent: z.string().nullable().optional().describe("Parent node name or id; null moves to top level"),
      summary: z.string().optional(),
      details: z.string().optional(),
      status: z.enum(["planned", "building", "live", "deprecated"]).optional(),
    }),
    run: (a, { project, ...n }) => svc.upsertNode(a, project, n),
  }),

  delete_node: tool({
    description: "Delete a node and everything nested in it.",
    input: z.object({ project, node: z.string() }),
    run: (a, i) => svc.deleteNode(a, i.project, i.node),
  }),

  upsert_edge: tool({
    description: 'Connect two nodes (by name or id), e.g. from "web" to "api" label "REST".',
    input: z.object({ project, from: z.string(), to: z.string(), label: z.string().optional() }),
    run: (a, { project, ...e }) => svc.upsertEdge(a, project, e),
  }),

  link_ticket_node: tool({
    description: "Link (or unlink) a ticket to an architecture node it touches.",
    input: z.object({ ticket, node: z.string(), unlink: z.boolean().optional() }),
    run: (a, i) => svc.linkTicketNode(a, i.ticket, i.node, i.unlink),
  }),
};

export type ToolName = keyof typeof tools;

export function listToolDefs() {
  return Object.entries(tools).map(([name, t]) => {
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
