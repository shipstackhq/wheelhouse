import http from "node:http";

/**
 * A small stand-in for github.com / api.github.com, enough for the calls Wheelhouse makes: installation tokens, the compare
 * and tree APIs, the installation's account and repositories, and the OAuth exchange used when connecting. The server under
 * test is pointed here with GITHUB_API_URL and GITHUB_WEB_URL.
 *
 * OAuth codes: "good" proves the installer administers installation `connectInstallationId`; "stranger" administers some
 * other installation; anything else is refused.
 */
export const LANDED_FILE = "src/contract/landed.ts";

/**
 * A stand-in for api.anthropic.com's streaming Messages call, which "Ask the map" makes from the server. It answers with text built
 * from what it was sent, so a test can see what the server asked and with what, without the answer ever containing the API key:
 * the project line of the map it was given, the question, the focus, and whether a key was sent at all.
 * Questions containing FAIL-RATE, FAIL-AUTH, FAIL-500 or TRUNCATE make it answer that way.
 */
function anthropicAnswer(req: http.IncomingMessage, raw: string, res: http.ServerResponse) {
  const sse = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const error = (status: number, type: string, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type, message } }));
  };
  const key = String(req.headers["x-api-key"] ?? "");
  if (!key) return error(401, "authentication_error", "invalid x-api-key");
  const body = JSON.parse(raw || "{}") as { system?: { text: string }[]; messages?: { content: string }[] };
  const user = String(body.messages?.[0]?.content ?? "");
  if (user.includes("FAIL-RATE")) return error(429, "rate_limit_error", "slow down");
  if (user.includes("FAIL-AUTH")) return error(401, "authentication_error", "invalid x-api-key");
  if (user.includes("FAIL-500")) return error(500, "api_error", "boom");
  const map = (body.system ?? []).map((b) => b.text).join("\n");
  const project = /# Project ([A-Z0-9]+): ([^\n]*)/.exec(map)?.[0] ?? "no project line";
  const nodes = [...map.matchAll(/^#{3,6} (\w+:[^\n(]+) \(/gm)].map((m) => m[1].trim());
  const text = `FAKE ANSWER. Map: ${project}. Nodes: ${nodes.join(", ") || "none"}. Asked: ${user.replace(/\n+/g, " ")}. Server-side key sent: yes. See [[system:Example]].`;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  sse("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  sse("content_block_stop", { type: "content_block_stop", index: 0 });
  sse("message_delta", { type: "message_delta", delta: { stop_reason: user.includes("TRUNCATE") ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  sse("message_stop", { type: "message_stop" });
  res.end();
}

export function startFakeGithub(port: number, connectInstallationId: string): Promise<{ close: () => Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push(`${req.method} ${url.pathname}`);
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const p = url.pathname;
      if (req.method === "POST" && p === "/v1/messages") return anthropicAnswer(req, Buffer.concat(chunks).toString(), res);
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (req.method === "POST" && /^\/app\/installations\/[^/]+\/access_tokens$/.test(p)) return json(res, 201, { token: "ghs_fake", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (req.method === "GET" && /^\/repositories\/[^/]+\/compare\//.test(p)) return json(res, 200, { files: [{ filename: LANDED_FILE, status: "modified", sha: "c0ffee0000000000000000000000000000000001" }] });
      if (req.method === "GET" && /^\/repositories\/[^/]+\/git\/trees\//.test(p)) return json(res, 200, { tree: [{ path: LANDED_FILE, type: "blob", sha: "c0ffee0000000000000000000000000000000001" }], truncated: false });
      if (req.method === "GET" && /^\/app\/installations\/[^/]+$/.test(p)) return json(res, 200, { account: { login: "contract-org", type: "Organization" } });
      if (req.method === "GET" && p === "/installation/repositories") return json(res, 200, { repositories: [{ id: 5001, full_name: "ct/app", default_branch: "main", private: false }] });
      if (req.method === "POST" && p === "/login/oauth/access_token") {
        const code = (JSON.parse(Buffer.concat(chunks).toString() || "{}") as { code?: string }).code;
        return code === "good" || code === "stranger" ? json(res, 200, { access_token: `gho_${code}` }) : json(res, 401, { error: "bad_verification_code" });
      }
      if (req.method === "GET" && p === "/user/installations") return json(res, 200, { installations: [{ id: bearer === "gho_good" ? Number(connectInstallationId) : 9999 }] });
      json(res, 404, { message: `fake github has no ${req.method} ${p}` });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ requests, close: () => new Promise((r) => server.close(() => r())) }));
  });
}
