import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { isApiPath, serveWebApp, webDistDir } from "./web-static";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-dist-"));
fs.mkdirSync(path.join(dir, "assets"));
fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Wheelhouse</title>");
fs.writeFileSync(path.join(dir, "sw.js"), "// worker");
fs.writeFileSync(path.join(dir, "manifest.webmanifest"), "{}");
fs.writeFileSync(path.join(dir, "icon.svg"), "<svg/>");
fs.writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
fs.writeFileSync(path.join(dir, "assets", "app-abc123.css"), "a{}");
fs.writeFileSync(path.join(path.dirname(dir), "wh-secret.txt"), "outside");

/** The handler in a tiny server; anything it passes on is answered 'api'. */
let server: http.Server;
let base = "";
before(async () => {
  const handler = serveWebApp(dir);
  server = http.createServer((req, res) => handler(req as Request, res as unknown as Response, () => res.writeHead(200, { "x-handled-by": "api" }).end("api")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(dir), "wh-secret.txt"), { force: true });
});

const get = (p: string, init: RequestInit = {}) => fetch(base + p, { redirect: "manual", ...init });

describe("the React app is served by the API process", () => {
  test("a page of the app, at any address, is the shell, and it is never cached", async () => {
    for (const p of ["/", "/login", "/p/WH/map", "/p/WH/docs?x=1", "/invite", "/admin/workspaces/abc"]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type")!, /^text\/html/);
      assert.equal(r.headers.get("cache-control"), "no-cache");
      assert.match(await r.text(), /<title>Wheelhouse<\/title>/);
    }
  });

  test("hashed assets are cached for a year; the worker and manifest never; other files for an hour", async () => {
    const js = await get("/assets/app-abc123.js");
    assert.equal(js.status, 200);
    assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(js.headers.get("content-type")!, /^text\/javascript/);
    assert.equal(await js.text(), "console.log(1)");
    assert.match((await get("/assets/app-abc123.css")).headers.get("content-type")!, /^text\/css/);
    assert.equal((await get("/sw.js")).headers.get("cache-control"), "no-cache");
    const manifest = await get("/manifest.webmanifest");
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
    assert.match(manifest.headers.get("content-type")!, /manifest\+json/);
    assert.equal((await get("/icon.svg")).headers.get("cache-control"), "public, max-age=3600");
    assert.equal((await get("/icon.svg")).headers.get("content-type"), "image/svg+xml");
  });

  test("a file that is not there is a 404, not a page: a stale script must not arrive as HTML", async () => {
    const r = await get("/assets/app-old999.js");
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type")!, /^text\/plain/);
    assert.equal((await get("/missing.png")).status, 404);
  });

  test("the API is never answered here: /api and /mcp go on, whatever the method", async () => {
    for (const p of ["/api/health", "/api/app/me", "/api/projects/WH/stream", "/mcp", "/mcp/x", "/api"]) {
      const r = await get(p);
      assert.equal(r.headers.get("x-handled-by"), "api", p);
    }
    assert.equal((await get("/api/app/projects", { method: "POST", body: "{}" })).headers.get("x-handled-by"), "api");
    assert.equal((await get("/login", { method: "POST", body: "{}" })).headers.get("x-handled-by"), "api", "only GET and HEAD are pages");
  });

  test("an ETag answers a repeat with 304; HEAD has no body", async () => {
    const first = await get("/sw.js");
    const etag = first.headers.get("etag")!;
    assert.ok(etag);
    assert.equal((await get("/sw.js", { headers: { "if-none-match": etag } })).status, 304);
    const head = await get("/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("it cannot be walked out of its folder", async () => {
    for (const p of ["/..%2Fwh-secret.txt", "/%2e%2e/wh-secret.txt", "/assets/..%2F..%2Fwh-secret.txt", "/%00", "/%"]) {
      const r = await get(p);
      assert.ok(!(await r.clone().text()).includes("outside"), p);
    }
  });
});

describe("where the build is", () => {
  test("WEB_DIST names it; with no build there is nothing to serve (development uses Vite)", () => {
    assert.equal(webDistDir({ WEB_DIST: dir }, "/nowhere"), dir);
    assert.equal(webDistDir({ WEB_DIST: path.join(dir, "assets") }, "/nowhere"), null);
    assert.equal(webDistDir({}, "/nowhere/apps/api/src"), null);
  });
  test("api paths", () => {
    assert.ok(["/api", "/api/x", "/mcp", "/mcp/y"].every(isApiPath));
    assert.ok(!["/apiary", "/mcpx", "/p/api", "/"].some(isApiPath));
  });
});
