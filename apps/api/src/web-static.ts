import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

/**
 * Serving the React app from the API process (WH-99): one container, one port, one origin, so there is no CORS, the session
 * cookie and the CSRF check see the same host, and Caddy only has to proxy.
 *
 *  - Files in the build (`apps/web/dist`) are served as they are: hashed assets under /assets are cached for a year, the shell
 *    (index.html), the service worker and the manifest are never cached, so a new deploy is picked up at the next load.
 *  - Any other GET that is not the API is a page of the app (React Router decides what it shows), so it gets index.html.
 *    A missing file with an extension (a stale hashed asset) is a plain 404, never an HTML page pretending to be a script.
 *  - /api and /mcp are never touched here: they go on to the controllers.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

const NEVER_CACHED = new Set(["/index.html", "/sw.js", "/offline.html", "/manifest.webmanifest"]);

export const isApiPath = (p: string) => p === "/api" || p.startsWith("/api/") || p === "/mcp" || p.startsWith("/mcp/");

/** Where the build is: WEB_DIST, else `apps/web/dist` next to this app. Null when there is none (development serves the app with Vite). */
export function webDistDir(env: Record<string, string | undefined> = process.env, here = import.meta.dirname): string | null {
  const dir = env.WEB_DIST ? path.resolve(env.WEB_DIST) : path.resolve(here, "..", "..", "web", "dist");
  return fs.existsSync(path.join(dir, "index.html")) ? dir : null;
}

function cacheControl(urlPath: string) {
  if (NEVER_CACHED.has(urlPath)) return "no-cache";
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

export function serveWebApp(dir: string) {
  const root = path.resolve(dir);
  const send = (req: Request, res: Response, file: string, urlPath: string, stat: fs.Stats) => {
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", cacheControl(urlPath));
    res.setHeader("Content-Type", TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream");
    if (req.headers["if-none-match"] === etag) return void res.writeHead(304).end();
    res.setHeader("Content-Length", String(stat.size));
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
  };
  const fileAt = (urlPath: string) => {
    const file = path.join(root, urlPath);
    if (file !== root && !file.startsWith(root + path.sep)) return null; // no walking out of the folder
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? { file, stat } : null;
    } catch {
      return null;
    }
  };
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      return next();
    }
    if (isApiPath(urlPath) || urlPath.includes("\0")) return next();
    const hit = urlPath === "/" ? null : fileAt(urlPath);
    if (hit) return send(req, res, hit.file, urlPath, hit.stat);
    if (path.extname(urlPath)) return void res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found"); // a missing file, not a page of the app
    const shell = fileAt("/index.html");
    if (!shell) return next();
    return send(req, res, shell.file, "/index.html", shell.stat);
  };
}
