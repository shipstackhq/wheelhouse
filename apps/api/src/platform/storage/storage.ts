import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Object storage behind one small interface, so nothing else in the code knows where bytes live. Every feature that stores a
 * file (workspace images, profile pictures, whatever comes next) goes through `getStorage()`.
 *
 * Adapters: `local` (a directory; development, tests, single-box installs) and `s3` (anything that speaks the S3 protocol:
 * AWS S3, Cloudflare R2, MinIO, Garage, Ceph...). Choose with STORAGE_DRIVER; add another by implementing `ObjectStorage`.
 */
export type StoredObject = { body: Buffer; contentType: string };

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Null when there is no such object. */
  get(key: string): Promise<StoredObject | null>;
  /** Deleting what is not there is not an error. */
  delete(key: string): Promise<void>;
}

/** Keys are made here from ids and random parts, never from user input; still, refuse anything that could leave the root. */
function safeKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(key) || key.split("/").some((p) => p === "" || p === "." || p === "..")) throw new Error(`Invalid storage key: ${key}`);
  return key;
}

/** Files under a directory; the content type sits beside each object in a `.type` file. */
export class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string) {}
  private file(key: string) {
    return path.join(this.root, ...safeKey(key).split("/"));
  }
  async put(key: string, body: Buffer, contentType: string) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body);
    await fs.writeFile(`${f}.type`, contentType);
  }
  async get(key: string): Promise<StoredObject | null> {
    const f = this.file(key);
    try {
      const [body, type] = await Promise.all([fs.readFile(f), fs.readFile(`${f}.type`, "utf8").catch(() => "application/octet-stream")]);
      return { body, contentType: type };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string) {
    const f = this.file(key);
    await Promise.all([fs.rm(f, { force: true }), fs.rm(`${f}.type`, { force: true })]);
  }
}

export type S3Config = {
  /** e.g. https://s3.eu-west-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com, http://minio:9000 */
  endpoint: string;
  bucket: string;
  /** "auto" for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (endpoint/bucket/key), which self-hosted servers usually need. Default true. */
  pathStyle?: boolean;
};

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data).digest();
const hex = (data: crypto.BinaryLike) => crypto.createHash("sha256").update(data).digest("hex");
const encodePath = (p: string) => p.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

/** S3-compatible storage over plain `fetch` with AWS Signature V4: no SDK, so no vendor library in the dependency tree. */
export class S3Storage implements ObjectStorage {
  constructor(private readonly cfg: S3Config, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {}

  private url(key: string) {
    const u = new URL(this.cfg.endpoint);
    const k = encodePath(safeKey(key));
    if (this.cfg.pathStyle === false) u.hostname = `${this.cfg.bucket}.${u.hostname}`;
    const base = u.pathname.replace(/\/+$/, "");
    u.pathname = this.cfg.pathStyle === false ? `${base}/${k}` : `${base}/${encodePath(this.cfg.bucket)}/${k}`;
    return u;
  }

  /** The request headers with the Authorization of a signed request. */
  sign(method: string, url: URL, body: Buffer | undefined, extra: Record<string, string> = {}): Record<string, string> {
    const date = this.now().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = date.slice(0, 8);
    const payloadHash = hex(body ?? "");
    const headers: Record<string, string> = { ...extra, host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": date };
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
    const canonical = [method, url.pathname, url.searchParams.toString(), ...names.map((n) => `${n}:${lower[n]}`), "", names.join(";"), payloadHash].join("\n");
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", date, scope, hex(canonical)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, day), this.cfg.region), "s3"), "aws4_request");
    const signature = crypto.createHmac("sha256", signingKey).update(toSign).digest("hex");
    const send = { ...headers };
    delete send.host; // fetch sets Host itself; it was only needed for the signature
    return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
  }

  private async call(method: string, key: string, body?: Buffer, contentType?: string) {
    const url = this.url(key);
    const headers = this.sign(method, url, body, contentType ? { "content-type": contentType } : {});
    return this.fetchImpl(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
  }

  async put(key: string, body: Buffer, contentType: string) {
    const res = await this.call("PUT", key, body, contentType);
    if (!res.ok) throw new Error(`Object storage refused the upload (${res.status})`);
  }
  async get(key: string): Promise<StoredObject | null> {
    const res = await this.call("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Object storage refused the read (${res.status})`);
    return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }
  async delete(key: string) {
    const res = await this.call("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`Object storage refused the delete (${res.status})`);
  }
}

/** The adapter the environment asks for. STORAGE_DRIVER=local (default, STORAGE_DIR) or s3 (STORAGE_S3_*). */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const driver = (env.STORAGE_DRIVER ?? "local").toLowerCase();
  if (driver === "local") return new LocalStorage(env.STORAGE_DIR ?? path.join(process.cwd(), ".data", "uploads"));
  if (driver === "s3") {
    const need = (k: string) => env[k] || (() => { throw new Error(`${k} is required when STORAGE_DRIVER=s3`); })();
    return new S3Storage({
      endpoint: need("STORAGE_S3_ENDPOINT"),
      bucket: need("STORAGE_S3_BUCKET"),
      region: env.STORAGE_S3_REGION || "auto",
      accessKeyId: need("STORAGE_S3_ACCESS_KEY_ID"),
      secretAccessKey: need("STORAGE_S3_SECRET_ACCESS_KEY"),
      pathStyle: env.STORAGE_S3_PATH_STYLE !== "false",
    });
  }
  throw new Error(`Unknown STORAGE_DRIVER "${driver}" (use local or s3)`);
}

let current: ObjectStorage | undefined;
export function getStorage(): ObjectStorage {
  return (current ??= storageFromEnv());
}
/** For tests: use this storage from now on (undefined: back to the environment's). */
export function setStorage(s: ObjectStorage | undefined) {
  current = s;
}
