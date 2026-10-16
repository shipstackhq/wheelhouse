/**
 * Runs the contract suite (WH-89). The suite is plain HTTP against a base URL; this script supplies one.
 *
 * Default (local): seeds a throwaway database, starts the server under test on it, runs the suite, stops the server, then
 * does a second short pass against a server with no GitHub App configured.
 *
 *   pnpm test:contract
 *   pnpm test:contract --server-cmd "pnpm --filter api start"      # another server; {PORT} is replaced
 *   pnpm test:contract --database-url "postgres://u:p@host/wh_p{PASS}"   # a real Postgres: {PASS} becomes 1, then 2; both must exist and be empty
 *   pnpm test:contract --update-golden                              # accept a deliberate contract change
 *   pnpm test:contract --only mcp,v1                                # only files whose name contains one of these
 *
 * Against a server you started yourself (it needs the environment from `prepare`):
 *
 *   pnpm test:contract prepare --dir .work/mine --fake-port 4599    # seeds, writes .work/mine/server.env, prints it
 *   (start your server with that environment)
 *   pnpm test:contract --base-url http://localhost:3460 --fixtures .work/mine/fixtures.json --fake-port 4599
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { startFakeGithub } from "./lib/fake-github";
import type { Fixtures } from "./lib/fixtures";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const WORK = path.join(import.meta.dirname, ".work");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

function seed(dir: string, fakePort: number, github: boolean, pass = 1) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const url = opt("database-url")?.replaceAll("{PASS}", String(pass));
  const where = url ? ["--database-url", url] : ["--dir", path.join(dir, "db")];
  const r = spawnSync("pnpm", ["exec", "tsx", "--conditions=react-server", "tests/contract/seed.ts", ...where, "--out", path.join(dir, "fixtures.json"), "--fake-port", String(fakePort), ...(github ? [] : ["--no-github"])], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error("seeding failed");
  return JSON.parse(fs.readFileSync(path.join(dir, "fixtures.json"), "utf8")) as Fixtures;
}

async function waitHealthy(base: string, server: ChildProcess, ms = 240_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`the server exited early (code ${server.exitCode})`);
    try {
      const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the server did not become healthy within ${ms / 1000}s`);
}

function startServer(cmd: string, port: number, env: Record<string, string>, logFile: string) {
  const log = fs.openSync(logFile, "w");
  const child = spawn("sh", ["-c", cmd.replaceAll("{PORT}", String(port))], { cwd: ROOT, env: { ...process.env, ...env, PORT: String(port) }, detached: true, stdio: ["ignore", log, log] });
  return child;
}

/**
 * Stop the server and wait until its whole process group is really gone before returning, so the next pass cannot start
 * while the last one still holds its port, its database directory or its build cache. SIGTERM first (so PGlite flushes),
 * SIGKILL if it has not gone within 30 seconds.
 */
async function stopServer(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (seconds: number) => {
    for (let i = 0; i < seconds * 5 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
    return !alive();
  };
  if (!alive()) return;
  try {
    process.kill(-pid, "SIGTERM"); // the whole group, so a dev server's own child goes too
  } catch {
    /* already gone */
  }
  if (await gone(30)) return;
  console.warn("the server did not exit within 30s of SIGTERM; killing it");
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await gone(5);
}

/** Async on purpose: the fake GitHub lives in this process, so blocking here would stop it answering the server under test. */
function runTests(base: string, fixtures: string, files: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<number>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", "--test", "--test-concurrency=1", ...files], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, BASE_URL: base, CONTRACT_FIXTURES: fixtures, ...(flag("update-golden") ? { UPDATE_GOLDEN: "1" } : {}), ...extraEnv },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const allTests = () =>
  fs
    .readdirSync(import.meta.dirname)
    .filter((f) => f.endsWith(".contract.test.ts"))
    .filter((f) => !opt("only") || opt("only")!.split(",").some((part) => f.includes(part.trim())))
    .map((f) => path.join("tests", "contract", f));

async function main() {
  const fakePort = Number(opt("fake-port") ?? (await freePort()));

  if (args[0] === "prepare") {
    const dir = path.resolve(opt("dir") ?? path.join(WORK, "prepared"));
    const f = seed(dir, fakePort, !flag("no-github"));
    const env = Object.entries(f.serverEnv).map(([k, v]) => `${k}=${v}`).join("\n");
    fs.writeFileSync(path.join(dir, "server.env"), env + "\n"); // KEY=value lines, for docker --env-file and the like
    const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
    fs.writeFileSync(path.join(dir, "server.sh"), Object.entries(f.serverEnv).map(([k, v]) => `export ${k}=${quote(v)}`).join("\n") + "\n"); // for a shell: . server.sh
    console.log(`\nStart the server under test with that environment (${path.join(dir, "server.sh")} for a shell, server.env for docker), then:\n  pnpm test:contract --base-url <url> --fixtures ${path.join(dir, "fixtures.json")} --fake-port ${fakePort}`);
    return 0;
  }

  const files = allTests();
  if (!files.length) throw new Error("no contract test files matched");
  const unconfigured = files.filter((f) => f.includes("unconfigured"));
  const configured = files.filter((f) => !f.includes("unconfigured"));

  // Against a server that is already running.
  if (opt("base-url")) {
    const fixtures = path.resolve(opt("fixtures") ?? "");
    const fixture = JSON.parse(fs.readFileSync(fixtures, "utf8")) as Fixtures;
    const fake = fixture.github ? await startFakeGithub(fakePort, fixture.github.connectInstallationId) : null;
    try {
      return await runTests(opt("base-url")!, fixtures, fixture.github ? configured : unconfigured, fixture.github ? {} : { CONTRACT_NO_GITHUB: "1" });
    } finally {
      await fake?.close();
    }
  }

  const cmd = opt("server-cmd") ?? "pnpm exec next dev -p {PORT}";
  fs.mkdirSync(WORK, { recursive: true });
  let status = 0;

  // Pass 1: the GitHub App is configured, pointing at the fake.
  if (configured.length) {
    const dir = path.join(WORK, "pass1");
    const f = seed(dir, fakePort, true);
    const fake = await startFakeGithub(fakePort, f.github!.connectInstallationId);
    const port = await freePort();
    const server = startServer(cmd, port, f.serverEnv, path.join(WORK, "pass1-server.log"));
    try {
      await waitHealthy(`http://127.0.0.1:${port}`, server);
      status ||= await runTests(`http://127.0.0.1:${port}`, path.join(dir, "fixtures.json"), configured);
    } finally {
      await stopServer(server);
      await fake.close();
    }
  }

  // Pass 2: no GitHub App configured on the server.
  if (unconfigured.length) {
    const dir = path.join(WORK, "pass2");
    const f = seed(dir, fakePort, false, 2);
    const port = await freePort();
    const server = startServer(cmd, port, f.serverEnv, path.join(WORK, "pass2-server.log"));
    try {
      await waitHealthy(`http://127.0.0.1:${port}`, server);
      status ||= await runTests(`http://127.0.0.1:${port}`, path.join(dir, "fixtures.json"), unconfigured, { CONTRACT_NO_GITHUB: "1" });
    } finally {
      await stopServer(server);
    }
  }

  if (!flag("keep")) fs.rmSync(WORK, { recursive: true, force: true });
  return status;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
