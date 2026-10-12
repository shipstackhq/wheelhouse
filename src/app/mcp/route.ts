import { NextResponse } from "next/server";
import { actorFromRequest, AuthError } from "@/lib/auth";
import { listToolDefs, runTool } from "@/lib/tools";
import { ServiceError } from "@/lib/service";

/**
 * Stateless MCP server over Streamable HTTP (JSON responses, no SSE).
 *   claude mcp add --transport http wheelhouse https://<host>/mcp \
 *     --header "Authorization: Bearer wh_..."
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Wheelhouse is your team's shared kanban board + architecture map.
Workflow:
1. At the start of a task call get_changes for the project and handle what the team changed (new/edited/moved tickets, comments addressed to you). Then ack_changes with the highest seq handled.
2. Before working a ticket: get_ticket, move it to "In Progress" (claim_ticket if it's agent-claimable).
3. Talk to the team via comment on the ticket: questions, decisions, a summary of what you changed.
4. When done, move it to "Review". Create tickets for follow-up work you discover.
5. Keep the architecture map current: when you add or significantly change a service/module, upsert_node (nest modules under their service via parent) and upsert_edge for dependencies, and link_ticket_node.
Pass expected_version on edits; on a conflict, re-read — a human changed it.`;

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
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "shipstack-wheelhouse", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
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
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="wheelhouse"' },
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
