import type { Actor } from "./access";
import { listToolDefs, runTool } from "./tools";
import { ServiceError } from "./service";
import { getPrompt, listPromptDefs } from "./prompts";

/**
 * The Model Context Protocol server, stateless over Streamable HTTP with JSON responses (no SSE):
 *   claude mcp add --transport http wheelhouse https://<host>/mcp --header "Authorization: Bearer wh_..."
 * Hosts authenticate the request first, then hand the raw body here. Framework-free, so the Next app and the API answer
 * identically.
 */

export const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Wheelhouse is your team's shared kanban board + knowledge map.
Start of a session: call get_briefing (compact project context) instead of exploring the codebase; before working an issue call get_issue_context and read the files it lists first.
Board workflow:
1. At the start of a task call get_changes for the project and handle what the team changed (new/edited/moved issues, comments addressed to you). It also lists staleNodes: map nodes whose code changed. Then ack_changes with the highest seq handled.
2. Before working an issue: get_issue, move it to "In Progress" (claim_issue if it's agent-claimable).
3. Talk to the team via comment on the issue: questions, decisions, a summary of what you changed.
4. When done, move it to "Review". Create issues for follow-up work you discover.
Knowledge map (concept → system → code layers, linked by "implements"):
5. Read it before structural work (get_graph, get_node). It's how humans understand the codebase without reading code, so keep it true.
6. After finishing work: report_changes with the files you touched, then re-describe any node that became stale (or mark_fresh), add nodes/edges/implements for new parts, update affected flows, and record an ADR for non-obvious choices.
Pass expected_version on issue edits; on a conflict, re-read — a human changed it.
Prompts: brief (load the briefing), map_codebase (bootstrap the map), map_schema (tables + relationships), refresh_map (fix stale nodes), explain.`;

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const ok = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: RpcReq["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: RpcReq, getActor: () => Promise<Actor>) {
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
      const actor = await getActor();
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

/**
 * Answer one POST body (already authenticated). `getActor` is called for each tool call, so a host may resolve the caller
 * again per call (the Next app does) or hand back the one it already has (the API does).
 */
export async function runMcp(raw: string, getActor: () => Promise<Actor>): Promise<{ status: number; body?: unknown }> {
  let body: RpcReq | RpcReq[];
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: err(null, -32700, "Parse error") };
  }

  const batch = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const m of batch) {
    if (m.id === undefined || m.id === null) continue; // notification: no response
    try {
      responses.push(await handle(m, getActor));
    } catch (e) {
      console.error("[mcp]", e);
      responses.push(err(m.id, -32603, e instanceof Error ? e.message : "Internal error"));
    }
  }
  if (!responses.length) return { status: 202 };
  return { status: 200, body: Array.isArray(body) ? responses : responses[0] };
}
