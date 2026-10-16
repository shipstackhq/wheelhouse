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
