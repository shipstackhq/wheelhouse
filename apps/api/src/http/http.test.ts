import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { clientIp } from "../common/rate-limit";
import { cookieValue, toHeaders } from "./util";
import { rawText } from "./raw-text";

describe("cookieValue", () => {
  test("finds one cookie among several, and decodes it", () => {
    assert.equal(cookieValue("a=1; wh_session=abc%2Fdef; b=2", "wh_session"), "abc/def");
    assert.equal(cookieValue("wh_session=plain", "wh_session"), "plain");
  });
  test("a missing header, a missing cookie, a similar name and a bad escape", () => {
    assert.equal(cookieValue(undefined, "wh_session"), undefined);
    assert.equal(cookieValue("other=1", "wh_session"), undefined);
    assert.equal(cookieValue("xwh_session=1; wh_session_old=2", "wh_session"), undefined);
    assert.equal(cookieValue("wh_session=100%", "wh_session"), "100%", "an invalid escape is kept as written");
  });
  test("the value may contain an equals sign", () => {
    assert.equal(cookieValue("wh_session=a=b==", "wh_session"), "a=b==");
  });
});

describe("toHeaders and the client address", () => {
  test("repeated headers are joined, so the LAST x-forwarded-for entry (the proxy's) is the client", () => {
    const h = toHeaders({ "x-forwarded-for": ["1.1.1.1", "9.9.9.9"], authorization: "Bearer x", skipped: undefined });
    assert.equal(h.get("x-forwarded-for"), "1.1.1.1, 9.9.9.9");
    assert.equal(h.get("authorization"), "Bearer x");
    assert.equal(clientIp(h), "9.9.9.9");
    assert.equal(clientIp(toHeaders({ "x-forwarded-for": "6.6.6.6, 7.7.7.7" })), "7.7.7.7");
    assert.equal(clientIp(toHeaders({ "x-real-ip": "5.5.5.5" })), "5.5.5.5");
    assert.equal(clientIp(toHeaders({})), "unknown");
  });
});

describe("rawText middleware", () => {
  const run = (method: string, chunks: string[], limit: number) =>
    new Promise<{ nextCalled: boolean; body?: string; status?: number; sent?: string }>((resolve) => {
      const req = Object.assign(new EventEmitter(), { method, rawText: undefined as string | undefined });
      const res = {
        statusCode: 0,
        status(c: number) {
          this.statusCode = c;
          return this;
        },
        type() {
          return this;
        },
        send(t: string) {
          resolve({ nextCalled: false, status: this.statusCode, sent: t });
        },
      };
      rawText(limit)(req as never, res as never, (() => resolve({ nextCalled: true, body: req.rawText })) as never);
      if (method !== "GET") {
        for (const c of chunks) req.emit("data", Buffer.from(c));
        req.emit("end");
      }
    });

  test("reads the body as text and calls next", async () => {
    assert.deepEqual(await run("POST", ['{"a":', '"é"}'], 1000), { nextCalled: true, body: '{"a":"é"}' });
  });
  test("an empty body is an empty string, not undefined", async () => {
    assert.deepEqual(await run("POST", [], 1000), { nextCalled: true, body: "" });
  });
  test("GET, HEAD, DELETE and OPTIONS are not read", async () => {
    for (const m of ["GET", "HEAD", "DELETE", "OPTIONS"]) assert.deepEqual(await run(m, [], 10), { nextCalled: true, body: undefined }, m);
  });
  test("a body over the limit is a plain 413 and never reaches the handler", async () => {
    assert.deepEqual(await run("POST", ["12345", "67890"], 8), { nextCalled: false, status: 413, sent: "Too large" });
  });
});
