import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalStorage, S3Storage, storageFromEnv } from "./storage";
import { parseUpload, sniffImageType } from "../../modules/images/index";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);

test("local storage: put, get, delete, and keys cannot leave the root", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wh-storage-"));
  const s = new LocalStorage(dir);
  assert.equal(await s.get("avatars/u1/a.png"), null);
  await s.put("avatars/u1/a.png", PNG, "image/png");
  const got = await s.get("avatars/u1/a.png");
  assert.equal(got?.contentType, "image/png");
  assert.ok(got?.body.equals(PNG));
  await s.delete("avatars/u1/a.png");
  await s.delete("avatars/u1/a.png");
  assert.equal(await s.get("avatars/u1/a.png"), null);
  await assert.rejects(s.put("../escape.png", PNG, "image/png"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("s3 storage: signed path-style requests, 404 is null", async () => {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fake = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), method: init.method!, headers: init.headers as Record<string, string> });
    return init.method === "GET" ? new Response(null, { status: 404 }) : new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const s = new S3Storage({ endpoint: "http://minio:9000", bucket: "wh", region: "auto", accessKeyId: "AK", secretAccessKey: "SK" }, fake, () => new Date("2026-01-02T03:04:05Z"));
  await s.put("workspaces/w1/x.png", PNG, "image/png");
  assert.equal(calls[0].url, "http://minio:9000/wh/workspaces/w1/x.png");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].headers["x-amz-date"], "20260102T030405Z");
  assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/20260102\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(await s.get("workspaces/w1/x.png"), null);
  await s.delete("workspaces/w1/x.png");
  assert.equal(calls[2].method, "DELETE");
});

test("the driver comes from the environment", () => {
  assert.ok(storageFromEnv({ STORAGE_DRIVER: "local", STORAGE_DIR: "/tmp/x" }) instanceof LocalStorage);
  assert.throws(() => storageFromEnv({ STORAGE_DRIVER: "s3" }), /STORAGE_S3_ENDPOINT/);
  assert.throws(() => storageFromEnv({ STORAGE_DRIVER: "ftp" }), /Unknown STORAGE_DRIVER/);
});

test("uploads: judged by their bytes, not their label; size capped", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(parseUpload(`data:image/png;base64,${PNG.toString("base64")}`).contentType, "image/png");
  assert.throws(() => parseUpload(Buffer.from("<svg onload=alert(1)>").toString("base64")), /PNG, JPEG, WebP or GIF/);
  assert.throws(() => parseUpload(""), /Choose an image/);
  assert.throws(() => parseUpload(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]).toString("base64")), /too large/);
});
