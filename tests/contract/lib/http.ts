/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON from an HTTP response is untyped by nature; the tests assert on it */
import fs from "node:fs";
import crypto from "node:crypto";
import type { Fixtures } from "./fixtures";

/**
 * Black-box helpers: plain HTTP against BASE_URL with the credentials in CONTRACT_FIXTURES. Nothing here imports the app, so
 * the same tests can be pointed at any server that implements the contract.
 */
export const BASE = (process.env.BASE_URL ?? "").replace(/\/+$/, "");
export const fx: Fixtures = JSON.parse(fs.readFileSync(process.env.CONTRACT_FIXTURES ?? "missing-CONTRACT_FIXTURES", "utf8"));

// The server counts failed key attempts per client address (the last X-Forwarded-For entry), so each call gets its own
// address by default and rate-limit tests never leak into the others.
let n = 0;
export const freshIp = () => `10.${(++n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

export type As = { key?: string | null; cookie?: string | null };
export const asKey = (key: string): As => ({ key });
export const asCookie = (token: string): As => ({ cookie: token });

export type Res = { status: number; headers: Headers; text: string; json: any; cookies: string[] };

export type CallOpts = As & {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  ip?: string;
  redirect?: RequestRedirect;
  /** Extra cookies, name=value, sent along with the session cookie. */
  extraCookies?: string[];
};

export async function call(path: string, o: CallOpts = {}): Promise<Res> {
  const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? freshIp(), ...(o.headers ?? {}) };
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const cookies = [...(o.cookie ? [`wh_session=${o.cookie}`] : []), ...(o.extraCookies ?? [])];
  if (cookies.length) headers.cookie = cookies.join("; ");
  let body: string | undefined = o.rawBody;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await fetch(BASE + path, { method: o.method ?? (body !== undefined ? "POST" : "GET"), headers, body, redirect: o.redirect ?? "manual", signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json, cookies: res.headers.getSetCookie() };
}

// ───────── MCP and REST ─────────

export const mcp = (as: As, method: string, params?: unknown, id: number | string | null = 1, extra: CallOpts = {}) =>
  call("/mcp", { ...as, ...extra, body: { jsonrpc: "2.0", id, method, params } });

/** The JSON a successful tools/call returns as text. */
export const mcpToolResult = (r: Res) => JSON.parse(r.json.result.content[0].text);

export const v1 = (as: As, tool: string, args: Record<string, unknown> = {}, extra: CallOpts = {}) => call(`/api/v1/${tool}`, { ...as, ...extra, body: args });

/** v1 call that must succeed; returns `data`. */
export async function v1ok(as: As, tool: string, args: Record<string, unknown> = {}) {
  const r = await v1(as, tool, args);
  if (r.status !== 200) throw new Error(`${tool} answered ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json.data;
}

// ───────── webhooks ─────────

export const sign = (secret: string, body: string) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

let delivery = 0;
export const deliveryId = () => `contract-${process.pid}-${Date.now()}-${++delivery}`;

export function deliver(event: string | null, payload: unknown, o: { id?: string | null; secret?: string | null; signature?: string | null; raw?: string } = {}) {
  const raw = o.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = o.secret === undefined ? fx.github?.webhookSecret : o.secret;
  const signature = o.signature !== undefined ? o.signature : secret ? sign(secret, raw) : null;
  if (signature) headers["x-hub-signature-256"] = signature;
  if (event) headers["x-github-event"] = event;
  const id = o.id === undefined ? deliveryId() : o.id;
  if (id) headers["x-github-delivery"] = id;
  return call("/api/webhooks/github", { method: "POST", headers, rawBody: raw });
}

// ───────── server-sent events ─────────

export type SseEvent = { id?: string; event?: string; data?: any; raw: string };

export async function openSse(path: string, o: { cookie?: string | null; key?: string | null; headers?: Record<string, string> } = {}) {
  const ctrl = new AbortController();
  const headers: Record<string, string> = { "x-forwarded-for": freshIp(), accept: "text/event-stream", ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = `wh_session=${o.cookie}`;
  if (o.key) headers.authorization = `Bearer ${o.key}`;
  const res = await fetch(BASE + path, { headers, signal: ctrl.signal });
  const events: SseEvent[] = [];
  const waiters: (() => void)[] = [];
  let body = "";
  if (res.ok && res.body) {
    (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev: SseEvent = { raw: frame };
            for (const line of frame.split("\n")) {
              if (line.startsWith("id: ")) ev.id = line.slice(4);
              else if (line.startsWith("event: ")) ev.event = line.slice(7);
              else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
            }
            if (ev.event || ev.id) events.push(ev);
            waiters.splice(0).forEach((w) => w());
          }
        }
      } catch {
        /* aborted */
      }
    })();
  } else {
    body = await res.text();
  }
  return {
    status: res.status,
    headers: res.headers,
    body,
    events,
    /** Resolves with the first event matching, or rejects after `ms`. */
    async waitFor(pred: (e: SseEvent) => boolean, ms = 15_000): Promise<SseEvent> {
      const until = Date.now() + ms;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        const left = until - Date.now();
        if (left <= 0) throw new Error(`no matching event within ${ms}ms; saw ${JSON.stringify(events.map((e) => e.raw))}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, Math.min(left, 250));
        });
      }
    },
    close: () => ctrl.abort(),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
