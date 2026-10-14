import { NextResponse } from "next/server";
import { actorFromRequest, AuthError } from "@/lib/auth";
import { listToolDefs, runTool } from "@/lib/tools";
import { ServiceError } from "@/lib/service";
import { getPrompt, listPromptDefs } from "@/lib/prompts";

/**
 * Stateless MCP server over Streamable HTTP (JSON responses, no SSE).
 *   claude mcp add --transport http wheelhouse https://<host>/mcp \
 *     --header "Authorization: Bearer wh_..."
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Wheelhouse is your team's shared kanban board + knowledge map.
Start of a session: call get_briefing (compact project context) instead of exploring the codebase; before working a ticket call get_ticket_context and read the files it lists first.
Board workflow:
1. At the start of a task call get_changes for the project and handle what the team changed (new/edited/moved tickets, comments addressed to you). It also lists staleNodes: map nodes whose code changed. Then ack_changes with the highest seq handled.
2. Before working a ticket: get_ticket, move it to "In Progress" (claim_ticket if it's agent-claimable).
3. Talk to the team via comment on the ticket: questions, decisions, a summary of what you changed.
4. When done, move it to "Review". Create tickets for follow-up work you discover.
Knowledge map (concept → system → code layers, linked by "implements"):
5. Read it before structural work (get_graph, get_node). It's how humans understand the codebase without reading code, so keep it true.
6. After finishing work: report_changes with the files you touched, then re-describe any node that became stale (or mark_fresh), add nodes/edges/implements for new parts, update affected flows, and record an ADR for non-obvious choices.
Pass expected_version on ticket edits; on a conflict, re-read — a human changed it.
Prompts: brief (load the briefing), map_codebase (bootstrap the map), map_schema (tables + relationships), refresh_map (fix stale nodes), explain.`;

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const ok = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: RpcReq["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: RpcReq) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const requested = String(params?.protocolVersion ?? "");
      return ok(id, {
        protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: "shipstack-wheelhouse", version: "0.2.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "prompts/list":
      return ok(id, { prompts: listPromptDefs() });
    case "prompts/get": {
      try {
        const p = getPrompt(String(params?.name ?? ""), (params?.arguments as Record<string, string>) ?? {});
        return p ? ok(id, p) : err(id, -32602, `Unknown prompt: ${params?.name}`);
      } catch (e) {
        return err(id, -32602, e instanceof Error ? e.message : "Invalid prompt arguments");
      }
    }
    case "tools/list":
      return ok(id, { tools: listToolDefs() });
    case "tools/call": {
      const actor = await actorFromRequest();
      const name = String(params?.name ?? "");
      try {
        const result = await runTool(actor, name, params?.arguments);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        if (e instanceof ServiceError) {
          const detail = e.details ? `\n${JSON.stringify(e.details, null, 2)}` : "";
          return ok(id, { content: [{ type: "text", text: `${e.code}: ${e.message}${detail}` }], isError: true });
        }
        throw e;
      }
    }
    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(req: Request) {
  // Authenticate every request up front so a bad key fails at connect time.
  try {
    await actorFromRequest();
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(err(null, -32001, e.message), {
        status: e.status,
        headers: e.retryAfter
          ? { "Retry-After": String(e.retryAfter) }
          : e.status === 401
            ? { "WWW-Authenticate": 'Bearer realm="wheelhouse"' }
            : undefined,
      });
    }
    throw e;
  }

  let body: RpcReq | RpcReq[];
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(err(null, -32700, "Parse error"), { status: 400 });
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const m of batch) {
    if (m.id === undefined || m.id === null) continue; // notification: no response
    try {
      responses.push(await handle(m));
    } catch (e) {
      console.error("[mcp]", e);
      responses.push(err(m.id, -32603, e instanceof Error ? e.message : "Internal error"));
    }
  }
  if (!responses.length) return new Response(null, { status: 202 });
  return NextResponse.json(Array.isArray(body) ? responses : responses[0]);
}

export async function GET() {
  // No server-initiated SSE stream in this stateless server.
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405 });
}
