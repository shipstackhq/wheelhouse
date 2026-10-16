import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import * as svc from "./service";
import { ServiceError } from "./service";
import type { ChecklistState } from "./setup-checklist";

/**
 * What the web app's board and ticket dialog read and write (WH-96), as functions of the signed-in person. The API's controllers
 * call these and nothing else. Everything is scoped by the actor's team through the service layer, so another team's project or
 * ticket is simply "not found". Responses carry only what the screens use, never raw rows.
 */

export type TicketView = {
  id: string;
  ref: string;
  number: number;
  title: string;
  body: string;
  columnId: string;
  priority: (typeof schema.PRIORITIES)[number];
  assigneeId: string | null;
  agentClaimable: boolean;
  claimedByKeyId: string | null;
  labels: string[];
  position: number;
  version: number;
  createdByKind: "human" | "agent";
  createdAt: Date;
  updatedAt: Date;
};

type TicketRow = typeof schema.tickets.$inferSelect & { ref: string };

export const ticketView = (t: TicketRow): TicketView => ({
  id: t.id,
  ref: t.ref,
  number: t.number,
  title: t.title,
  body: t.body,
  columnId: t.columnId,
  priority: t.priority,
  assigneeId: t.assigneeId,
  agentClaimable: t.agentClaimable,
  claimedByKeyId: t.claimedByKeyId,
  labels: t.labels,
  position: t.position,
  version: t.version,
  createdByKind: t.createdByKind,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

/** A ticket on the board also says which map nodes it touches and how many comments it has. */
export type BoardTicket = TicketView & { nodeIds: string[]; commentCount: number };

export type BoardView = {
  project: { id: string; key: string; name: string; description: string };
  columns: { id: string; name: string; role: string | null; position: number }[];
  tickets: BoardTicket[];
  /** Just enough of the map to show and link nodes. The map itself is another page. */
  nodes: { id: string; name: string; kind: string; parentId: string | null; layer: string }[];
  members: { id: string; name: string }[];
  checklist: ChecklistState;
};

/** The project page: its columns, every ticket, the map nodes a ticket can link to, the team's members and the setup checklist. */
export async function boardView(actor: Actor, projectKey: string): Promise<BoardView> {
  const [board, checklist] = await Promise.all([svc.getBoard(actor, projectKey), svc.checklistForProject(actor, projectKey)]);
  const db = await getDb();
  const [nodes, members] = await Promise.all([
    db
      .select({ id: schema.nodes.id, name: schema.nodes.name, kind: schema.nodes.kind, parentId: schema.nodes.parentId, layer: schema.nodes.layer })
      .from(schema.nodes)
      .where(eq(schema.nodes.projectId, board.project.id)),
    db
      .select({ id: schema.users.id, name: schema.users.name })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.teamId, actor.teamId)),
  ]);
  return {
    project: { id: board.project.id, key: board.project.key, name: board.project.name, description: board.project.description },
    columns: board.columns.map((c) => ({ id: c.id, name: c.name, role: c.role ?? null, position: c.position })),
    tickets: board.tickets.map((t) => ({ ...ticketView(t), nodeIds: t.nodeIds, commentCount: t.commentCount })),
    nodes,
    members,
    checklist,
  };
}

export type TicketDetail = {
  ticket: TicketView & { column: string | undefined };
  project: { key: string; name: string };
  comments: { id: string; authorKind: "human" | "agent"; authorName: string; body: string; createdAt: Date }[];
  nodes: { id: string; name: string; kind: string; parentId: string | null }[];
  history: { seq: number; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: Date }[];
  pullRequests: Awaited<ReturnType<typeof import("./github/service").pullRequestsForTicket>>;
};

/** One ticket for the dialog: its fields, discussion, linked map nodes, history and the pull requests GitHub reported against it. */
export async function ticketDetail(actor: Actor, ref: string): Promise<TicketDetail> {
  const d = await svc.getTicket(actor, ref);
  return {
    ticket: { ...ticketView(d.ticket), column: d.ticket.column },
    project: { key: d.project.key, name: d.project.name },
    comments: d.comments.map((c) => ({ id: c.id, authorKind: c.authorKind, authorName: c.authorName, body: c.body, createdAt: c.createdAt })),
    nodes: d.nodes,
    history: d.history.map((e) => ({ seq: e.seq, actorKind: e.actorKind, actorName: e.actorName, summary: e.summary, createdAt: e.createdAt })),
    pullRequests: d.pullRequests,
  };
}

// ───────── reading a request body ─────────

const bad = (field: string, message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

/** A whole number from a JSON body, or undefined when absent. Anything else (a string, 1.5, NaN) is a field error. */
export function intField(b: Record<string, unknown>, name: string): number | undefined {
  const v = b[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return bad(name, `${name} must be a whole number`);
  return v;
}

/**
 * The ticket fields a request may carry, checked the way the MCP tools check them (a string, a known priority, a list of strings,
 * true or false) so a wrong type is a 400 naming the field and never reaches the database. For a new ticket the title is required.
 */
export function ticketInput(b: Record<string, unknown>, o: { create: boolean }): svc.TicketInput {
  const out: svc.TicketInput = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string") bad("title", "title must be text");
    out.title = (b.title as string).trim();
    if (!out.title) bad("title", "title is required");
  } else if (o.create) bad("title", "title is required");
  if (b.body !== undefined) {
    if (typeof b.body !== "string") bad("body", "body must be text");
    out.body = b.body as string;
  }
  if (b.priority !== undefined) {
    if (typeof b.priority !== "string" || !(schema.PRIORITIES as readonly string[]).includes(b.priority)) bad("priority", `priority must be one of ${schema.PRIORITIES.join(", ")}`);
    out.priority = b.priority as (typeof schema.PRIORITIES)[number];
  }
  if (b.assigneeId !== undefined) {
    if (b.assigneeId !== null && typeof b.assigneeId !== "string") bad("assigneeId", "assigneeId must be a person's id, or null for nobody");
    out.assigneeId = (b.assigneeId as string | null) || null;
  }
  if (b.agentClaimable !== undefined) {
    if (typeof b.agentClaimable !== "boolean") bad("agentClaimable", "agentClaimable must be true or false");
    out.agentClaimable = b.agentClaimable as boolean;
  }
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels) || b.labels.some((l) => typeof l !== "string")) bad("labels", "labels must be a list of text");
    out.labels = b.labels as string[];
  }
  return out;
}

/** The column of a move or a new ticket: an id, a name or a role ("review"); the service finds it in this ticket's own project. */
export function columnField(b: Record<string, unknown>, required: boolean): string | undefined {
  const v = b.column;
  if (v === undefined || v === null) return required ? bad("column", "column is required") : undefined;
  if (typeof v !== "string" || !v.trim()) return bad("column", "column must be text");
  return v;
}

// ───────── changing a ticket ─────────

/**
 * A stale `version` is a 409 whose `details.current` is what the ticket is now. The service attaches the raw row; the web app is
 * given the same trimmed ticket every other answer uses, so the screen can show the conflict and offer the latest text.
 */
async function withCurrent<T>(actor: Actor, ref: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict" && (e.details as { current?: unknown } | undefined)?.current) {
      const now = await svc.resolveTicket(actor, ref);
      throw new ServiceError("conflict", e.message, { current: ticketView({ ...now.ticket, ref: now.ref }) });
    }
    throw e;
  }
}

export async function createTicketAs(actor: Actor, projectKey: string, input: svc.TicketInput & { title: string }, column?: string) {
  const t = await svc.createTicket(actor, projectKey, { ...input, column });
  return { ...ticketView(t), column: t.column };
}

/** Change fields. With `version`, a change made by anyone since is refused (409) and nothing is overwritten. */
export async function updateTicketAs(actor: Actor, ref: string, patch: svc.TicketInput, version?: number) {
  const t = await withCurrent(actor, ref, () => svc.updateTicket(actor, ref, patch, version));
  return ticketView(t);
}

/** Move to a column (an id, a name or a role such as "review") at a position (the end when absent). */
export async function moveTicketAs(actor: Actor, ref: string, column: string, index?: number, version?: number) {
  const t = await withCurrent(actor, ref, () => svc.moveTicket(actor, ref, column, index, version));
  return { ...ticketView(t), column: t.column };
}
