import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, test } from "vitest";

/**
 * public/sw.js, run for real in a sandbox with an in-memory Cache Storage and a fetch we control. The rules it must keep:
 * never cache /api/*, /mcp, anything that is not a GET, or anything from another origin; never cache a page.
 */
const ORIGIN = "https://wh.example";
const SOURCE = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");

class FakeCache {
  entries = new Map<string, Response>();
  private key = (r: Request | string) => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);
  async match(r: Request | string) {
    return this.entries.get(this.key(r))?.clone();
  }
  async put(r: Request | string, res: Response) {
    this.entries.set(this.key(r), res);
  }
  async add(url: string) {
    this.entries.set(this.key(url), new Response(`<html>offline page</html>`, { headers: { "content-type": "text/html" } }));
  }
}
class FakeCaches {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  /** Every URL stored anywhere. */
  get urls() {
    return [...this.stores.entries()].flatMap(([n, c]) => [...c.entries.keys()].map((u) => `${n} ${new URL(u).pathname}`));
  }
}

type Handler = (e: Record<string, unknown>) => void;
function load() {
  const handlers = new Map<string, Handler>();
  const caches = new FakeCaches();
  const net = { fetched: [] as string[], respond: (...[]: [string]): Response | Promise<Response> => new Response("from the network") };
  const calls = { skipWaiting: 0, claim: 0 };
  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
      skipWaiting: () => void calls.skipWaiting++,
      clients: { claim: async () => void calls.claim++ },
    },
    caches,
    fetch: async (req: Request | string) => {
      const url = typeof req === "string" ? req : req.url;
      net.fetched.push(new URL(url).pathname);
      return net.respond(url);
    },
    Response,
    URL,
  };
  vm.runInNewContext(SOURCE, sandbox);

  const waits: Promise<unknown>[] = [];
  const event = (extra: Record<string, unknown>) => ({ waitUntil: (p: Promise<unknown>) => void waits.push(p), ...extra });
  return {
    caches,
    net,
    calls,
    handlers,
    async install() {
      handlers.get("install")!(event({}));
      await Promise.all(waits.splice(0));
    },
    async activate() {
      handlers.get("activate")!(event({}));
      await Promise.all(waits.splice(0));
    },
    async message(data: string) {
      handlers.get("message")!(event({ data }));
      await Promise.all(waits.splice(0));
    },
    /** Dispatch a fetch. `intercepted` is whether the worker took it over; `response` is what it answered. */
    async fetch(url: string, init: { method?: string; mode?: string } = {}) {
      let answer: Promise<Response> | undefined;
      const request = { url: new URL(url, ORIGIN).href, method: init.method ?? "GET", mode: init.mode ?? "no-cors", headers: new Headers() };
      handlers.get("fetch")!({ request, respondWith: (p: Promise<Response>) => void (answer = p) });
      return { intercepted: !!answer, response: answer ? await answer : undefined };
    },
  };
}

let sw: ReturnType<typeof load>;
beforeEach(async () => {
  sw = load();
  await sw.install();
});

describe("installing and updating", () => {
  test("keeps the static offline page and does not take over before the person agrees", () => {
    expect(sw.caches.urls).toEqual(["wh-pages-v2 /offline.html"]);
    expect(sw.calls.skipWaiting).toBe(0);
  });

  test("an update waits until the page sends SKIP_WAITING", async () => {
    await sw.message("anything else");
    expect(sw.calls.skipWaiting).toBe(0);
    await sw.message("SKIP_WAITING");
    expect(sw.calls.skipWaiting).toBe(1);
  });

  test("activating removes caches from older versions and keeps the current two", async () => {
    await sw.caches.open("wh-static-v1");
    await sw.caches.open("wh-pages-v1");
    await sw.caches.open("something-else");
    await sw.caches.open("wh-static-v2");
    await sw.activate();
    expect((await sw.caches.keys()).sort()).toEqual(["wh-pages-v2", "wh-static-v2"]);
    expect(sw.calls.claim).toBe(1);
  });

  test("CLEAR_CACHES (sent before signing out) wipes the pages cache and puts the offline page back", async () => {
    const pages = await sw.caches.open("wh-pages-v2");
    await pages.put("/p/WH", new Response("a person's page"));
    await sw.message("CLEAR_CACHES");
    expect(sw.caches.urls).toEqual(["wh-pages-v2 /offline.html"]);
  });
});

describe("what it leaves alone", () => {
  test.each([
    ["a POST", "/api/app/auth/login", { method: "POST" }],
    ["a PUT", "/assets/app.js", { method: "PUT" }],
    ["a DELETE", "/api/app/keys/1", { method: "DELETE" }],
    ["an API read", "/api/app/me", { mode: "cors" }],
    ["the live stream", "/api/stream", {}],
    ["a project's live stream", "/api/projects/WH/stream", {}],
    ["MCP", "/mcp", {}],
    ["a browser navigation to the API (GitHub install, callback)", "/api/github/install?project=WH", { mode: "navigate" }],
    ["another origin's asset", "https://cdn.example/assets/app.js", {}],
    ["another origin's page", "https://evil.example/", { mode: "navigate" }],
    ["the manifest", "/manifest.webmanifest", {}],
    ["an icon", "/icon.svg", {}],
    ["the worker itself", "/sw.js", {}],
    ["an image request that is not a built asset", "/avatar.png", {}],
  ])("%s goes straight to the network and is never stored", async (_name, url, init) => {
    const before = sw.caches.urls;
    const r = await sw.fetch(url, init);
    expect(r.intercepted).toBe(false);
    expect(sw.net.fetched).toEqual([]);
    expect(sw.caches.urls).toEqual(before);
  });
});

describe("built files (/assets/)", () => {
  test("are fetched once, then served from the cache while a fresh copy is fetched behind", async () => {
    sw.net.respond = () => new Response("version one");
    const first = await sw.fetch("/assets/app-abc123.js");
    expect(first.intercepted).toBe(true);
    expect(await first.response!.text()).toBe("version one");
    await Promise.resolve();
    expect(sw.caches.urls).toContain("wh-static-v2 /assets/app-abc123.js");

    sw.net.respond = () => new Response("version two");
    const second = await sw.fetch("/assets/app-abc123.js");
    expect(await second.response!.text()).toBe("version one");
    expect(sw.net.fetched).toEqual(["/assets/app-abc123.js", "/assets/app-abc123.js"]);
  });

  test("a failed fetch is not stored", async () => {
    sw.net.respond = () => new Response("nope", { status: 404 });
    await (await sw.fetch("/assets/missing.js")).response!.text();
    await Promise.resolve();
    expect(sw.caches.urls).not.toContain("wh-static-v2 /assets/missing.js");
  });
});

describe("pages (navigation)", () => {
  test.each(["/", "/p/WH", "/p/WH/docs", "/workspace", "/login"])("%s comes from the network and is never stored", async (url) => {
    sw.net.respond = () => new Response("<html>a person's page</html>", { headers: { "content-type": "text/html" } });
    const r = await sw.fetch(url, { mode: "navigate" });
    expect(r.intercepted).toBe(true);
    expect(await r.response!.text()).toContain("a person's page");
    expect(sw.caches.urls).toEqual(["wh-pages-v2 /offline.html"]);
  });

  test("redirects and errors pass through untouched and are not stored", async () => {
    sw.net.respond = () => Response.redirect(`${ORIGIN}/login`, 302);
    expect((await sw.fetch("/p/WH", { mode: "navigate" })).response!.status).toBe(302);
    sw.net.respond = () => new Response("down", { status: 503 });
    expect((await sw.fetch("/p/WH", { mode: "navigate" })).response!.status).toBe(503);
    expect(sw.caches.urls).toEqual(["wh-pages-v2 /offline.html"]);
  });

  test("with no connection, the static offline page is shown", async () => {
    sw.net.respond = () => Promise.reject(new TypeError("Failed to fetch"));
    const r = await sw.fetch("/p/WH/docs", { mode: "navigate" });
    expect(await r.response!.text()).toBe("<html>offline page</html>");
  });

  test("with no connection and no offline page, the browser's own error is shown", async () => {
    sw.caches.stores.clear();
    sw.net.respond = () => Promise.reject(new TypeError("Failed to fetch"));
    const r = await sw.fetch("/p/WH", { mode: "navigate" });
    expect(r.response!.type).toBe("error");
  });
});

describe("the source", () => {
  test("holds nothing from the Next app's service worker", () => {
    expect(SOURCE).not.toMatch(/_next|RSC|Next-Action|_rsc/);
  });
  test("names the static offline page that is shipped", () => {
    expect(fs.existsSync(path.join(__dirname, "..", "public", "offline.html"))).toBe(true);
    expect(SOURCE).toContain('"/offline.html"');
  });
});
