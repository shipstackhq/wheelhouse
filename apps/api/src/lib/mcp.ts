import type { Actor } from "../common/actor";
import type { ToolsService } from "./tools";
import { ServiceError } from "../common/service-error";
import { getPrompt, listPromptDefs } from "./prompts";

/**
 * The Model Context Protocol server, stateless over Streamable HTTP with JSON responses (no SSE):
 *   claude mcp add --transport http wheelhouse https://<host>/mcp --header "Authorization: Bearer wh_..."
 * Hosts authenticate the request first, then hand the raw body here. Framework-free, so the Next app and the API answer
 * identically.
 */

export const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Wheelhouse is your team's shared board (issues, cycles, projects) and knowledge map (architecture, docs, decisions, glossary).
Every tool takes \`team\` (a team key like "WH"). A project is Linear's kind: work that spans teams and cycles.
Start of a session: get_briefing (compact team context) instead of exploring the codebase; before working an issue, get_issue and read the files it lists first.
Board workflow:
1. At the start of a task call get_changes and handle what the team changed (new/edited/moved issues, comments addressed to you, stale nodes and docs). Pass its latest seq as \`ack\` on the next call to acknowledge.
2. list_issues to find work (filter assignee "me", cycle "current"). Before working an issue: update_issue with status "in_progress" and assignee "me" (a claim, for agent-claimable issues).
3. Talk to the team with comment on the issue: questions, decisions, a summary of what you changed.
4. When done, update_issue to status "review". create_issue for follow-up work you discover, with its cycle, project and link_nodes set in the same call.
Planning: get_cycle and get_project read it; plan (needs the planning:write scope) creates and edits cycles, projects and milestones in a batch.
Knowledge map (concept, system, data and code layers, linked by "implements"):
5. Read it before structural work (get_map; node for one part, flow for a walkthrough, layer "data" for the schema). It's how humans understand the codebase without reading code, so keep it true.
6. After finishing work: get_stale, then re-describe stale nodes and docs (update_map, write_doc) or confirm them with mark_fresh; add nodes, edges and flows for new parts; record_decision for non-obvious choices; define_term for vocabulary. list_knowledge lists docs, decisions and terms; get_doc reads one.
Pass expected_version on edits; on a conflict, re-read: a human changed it.
Prompts: brief (load the briefing), map_codebase (bootstrap the map), map_schema (tables + relationships), refresh_map (fix stale nodes), explain.`;

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const ok = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: RpcReq["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(tools: ToolsService, msg: RpcReq, getActor: () => Promise<Actor>) {
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
      return ok(id, { tools: tools.list({ actor: await getActor() }) });
    case "tools/call": {
      const actor = await getActor();
      const name = String(params?.name ?? "");
      try {
        const result = await tools.run(actor, name, params?.arguments);
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
export async function runMcp(tools: ToolsService, raw: string, getActor: () => Promise<Actor>): Promise<{ status: number; body?: unknown }> {
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
      responses.push(await handle(tools, m, getActor));
    } catch (e) {
      console.error("[mcp]", e);
      responses.push(err(m.id, -32603, e instanceof Error ? e.message : "Internal error"));
    }
  }
  if (!responses.length) return { status: 202 };
  return { status: 200, body: Array.isArray(body) ? responses : responses[0] };
}
