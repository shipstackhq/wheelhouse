/**
 * Creates the accounts the contract tests sign in with, in a database of its own, and writes them to a fixtures file.
 * This is the only part of the suite that touches the app's code (to set up data); the tests themselves speak only HTTP.
 *
 *   tsx --conditions=react-server tests/contract/seed.ts --dir <pglite dir> --out <fixtures.json> --fake-port <n> [--no-github]
 *   tsx --conditions=react-server tests/contract/seed.ts --database-url <postgres url> --out <fixtures.json> --fake-port <n>   (a real Postgres; it must be empty)
 *
 * Run it while no server is using the database (PGlite allows one process per directory).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@wheelhouse/core/db";
import { scopeKeyToAllTeams } from "@wheelhouse/core/lib/key-scope";
import * as svc from "@wheelhouse/core/lib/service";
import type { Actor } from "@wheelhouse/core/lib/access";
import { hashPassword } from "@wheelhouse/core/lib/auth-core";
import type { Fixtures, GithubFixture, WorkspaceFixture } from "./lib/fixtures";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dir = arg("dir");
const databaseUrl = arg("database-url");
const out = arg("out");
const fakePort = Number(arg("fake-port") ?? 0);
const withGithub = !process.argv.includes("--no-github");
if ((!dir && !databaseUrl) || !out) throw new Error("usage: seed.ts (--dir <pglite dir> | --database-url <url>) --out <fixtures.json> --fake-port <n> [--no-github]");
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
} else {
  process.env.PGLITE_DIR = path.resolve(dir!);
  delete process.env.DATABASE_URL;
}

const PASSWORD = "contract-password-1";
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const token = (prefix: string) => `${prefix}${crypto.randomBytes(24).toString("base64url")}`;

async function workspace(letter: "A" | "B", passwordHash: string): Promise<WorkspaceFixture> {
  const db = await getDb();
  const [t] = await db.insert(schema.workspaces).values({ name: `Contract workspace ${letter}` }).returning();
  const mkUser = async (label: string, role: "owner" | "member") => {
    const [u] = await db.insert(schema.users).values({ email: `ct-${letter.toLowerCase()}-${label}@example.test`, name: `Contract ${letter} ${label}`, passwordHash }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: t.id, role });
    return u;
  };
  const session = async (userId: string, expiresAt: Date) => {
    const tok = token("sess_");
    await db.insert(schema.sessions).values({ id: sha256(tok), userId, expiresAt });
    return tok;
  };
  const owner = await mkUser("owner", "owner");
  const member = await mkUser("member", "member");
  const key = async (name: string, revoked = false) => {
    const k = token("wh_");
    const [row] = await db.insert(schema.apiKeys).values({ workspaceId: t.id, name, prefix: k.slice(0, 10), keyHash: sha256(k), createdBy: owner.id, revokedAt: revoked ? new Date() : null }).returning({ id: schema.apiKeys.id });
    await scopeKeyToAllTeams(db, row.id, t.id); // the team exists by now; a key reaches only the teams it is scoped to (WH-120)
    return k;
  };
  const actor: Actor = { kind: "human", id: owner.id, name: owner.name, workspaceId: t.id };
  const teamKey = `CT${letter}`;
  const team = await svc.createTeam(actor, { name: `Contract ${letter}`, key: teamKey });
  // A team is reachable only by its members (ADR-23): the owner got in by creating it, the workspace's other member is added here.
  await db.insert(schema.teamMembers).values({ teamId: team.id, userId: member.id, workspaceId: t.id, role: "editor", addedBy: owner.id });
  const issue = await svc.createIssue(actor, teamKey, { title: `Contract issue ${letter}` });
  const webhookIssue = await svc.createIssue(actor, teamKey, { title: `Webhook issue ${letter}` });
  return {
    workspaceId: t.id,
    userId: owner.id,
    email: owner.email,
    memberEmail: member.email,
    teamKey,
    issueRef: issue.ref,
    webhookIssueRef: webhookIssue.ref,
    apiKey: await key("contract key"),
    apiKey2: await key("second contract key"),
    revokedKey: await key("revoked contract key", true),
    sessionToken: await session(owner.id, new Date(Date.now() + 30 * 864e5)),
    expiredSessionToken: await session(owner.id, new Date(Date.now() - 864e5)),
    memberSessionToken: await session(member.id, new Date(Date.now() + 30 * 864e5)),
  };
}

async function main() {
  const db = await getDb();
  const passwordHash = await hashPassword(PASSWORD);
  const a = await workspace("A", passwordHash);
  const b = await workspace("B", passwordHash);

  // A suspended workspace: its keys are refused with 403 and its members count as signed out.
  const [st] = await db.insert(schema.workspaces).values({ name: "Contract suspended workspace", suspendedAt: new Date(), suspendedReason: "contract test" }).returning();
  const [su] = await db.insert(schema.users).values({ email: "ct-suspended@example.test", name: "Contract suspended", passwordHash }).returning();
  await db.insert(schema.memberships).values({ userId: su.id, workspaceId: st.id, role: "owner" });
  const skey = token("wh_");
  await db.insert(schema.apiKeys).values({ workspaceId: st.id, name: "suspended key", prefix: skey.slice(0, 10), keyHash: sha256(skey) });
  const stok = token("sess_");
  await db.insert(schema.sessions).values({ id: sha256(stok), userId: su.id, expiresAt: new Date(Date.now() + 30 * 864e5) });

  // An instance admin, alone in a workspace of their own (the web app's admin pages; the server is told this address in ADMIN_EMAILS).
  const ADMIN_EMAIL = "ct-admin@example.test";
  const [at] = await db.insert(schema.workspaces).values({ name: "Contract admin workspace" }).returning();
  const [au] = await db.insert(schema.users).values({ email: ADMIN_EMAIL, name: "Contract admin", passwordHash }).returning();
  await db.insert(schema.memberships).values({ userId: au.id, workspaceId: at.id, role: "owner" });

  // A workspace for the tests that connect GitHub repositories, so the seeded workspaces (and their team lists, webhooks and counts) stay as they are.
  const [ct] = await db.insert(schema.workspaces).values({ name: "Contract connect workspace" }).returning();
  const [cu] = await db.insert(schema.users).values({ email: "ct-connect-owner@example.test", name: "Contract connect owner", passwordHash }).returning();
  const [cm] = await db.insert(schema.users).values({ email: "ct-connect-member@example.test", name: "Contract connect member", passwordHash }).returning();
  await db.insert(schema.memberships).values([{ userId: cu.id, workspaceId: ct.id, role: "owner" }, { userId: cm.id, workspaceId: ct.id, role: "member" }]);

  let github: GithubFixture | null = null;
  const serverEnv: Record<string, string> = databaseUrl ? { DATABASE_URL: databaseUrl } : { PGLITE_DIR: path.resolve(dir!), DATABASE_URL: "" };
  if (withGithub) {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const fake = `http://127.0.0.1:${fakePort}`;
    github = {
      appSlug: "wheelhouse-contract",
      webhookSecret: crypto.randomBytes(16).toString("hex"),
      clientSecret: crypto.randomBytes(16).toString("hex"),
      apiUrl: fake,
      webUrl: fake,
      installationA: "1001",
      installationB: "1002",
      repoId: "5001",
      connectInstallationId: "2001",
      installationC: "3001",
      connectRepoId: "7001",
    };
    Object.assign(serverEnv, {
      GITHUB_APP_ID: "424242",
      GITHUB_APP_SLUG: github.appSlug,
      GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
      GITHUB_WEBHOOK_SECRET: github.webhookSecret,
      GITHUB_CLIENT_ID: "contract-client-id",
      GITHUB_CLIENT_SECRET: github.clientSecret,
      GITHUB_API_URL: fake,
      GITHUB_WEB_URL: fake,
    });
    // Both workspaces connect a repository with the SAME GitHub id, each through its own installation: a webhook for one must
    // never touch the other.
    for (const [t, installationId, p, team] of [[a, github.installationA, "CTA", "A"], [b, github.installationB, "CTB", "B"]] as const) {
      await db.insert(schema.githubInstallations).values({ installationId, workspaceId: t.workspaceId, accountLogin: `contract-${team}`, accountType: "Organization", connectedBy: t.userId });
      const proj = (await db.select().from(schema.teams).where(eq(schema.teams.workspaceId, t.workspaceId)))[0];
      await db.insert(schema.repositories).values({
        teamId: proj.id,
        workspaceId: proj.workspaceId,
        displayName: "app",
        role: "webapp",
        provider: "github",
        slug: `ct/app-${p.toLowerCase()}`,
        githubRepoId: github.repoId,
        githubInstallationId: installationId,
        githubFullName: "ct/app",
        defaultBranch: "main",
      });
    }
    await db.insert(schema.githubInstallations).values({ installationId: github.installationC, workspaceId: ct.id, accountLogin: "contract-connect", accountType: "Organization", connectedBy: cu.id });
    // A forged row: workspace B's team claims a repository through WORKSPACE A's installation. Webhooks must resolve an installation to
    // its own workspace (the join on github_installations.workspace_id), so this row must never be reached.
    const projB = (await db.select().from(schema.teams).where(eq(schema.teams.workspaceId, b.workspaceId)))[0];
    await db.insert(schema.repositories).values({ teamId: projB.id, workspaceId: projB.workspaceId, displayName: "forged", role: "webapp", provider: "github", slug: "ct/forged", githubRepoId: github.repoId, githubInstallationId: github.installationA, githubFullName: "ct/app", defaultBranch: "main" });
  } else {
    // Explicitly blank so a developer's own .env.local can never leak GitHub credentials into the server under test.
    for (const k of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_API_URL", "GITHUB_WEB_URL"]) serverEnv[k] = "";
  }

  serverEnv.ALLOW_SIGNUP = "true"; // the web-app API tests create accounts
  // "Ask the map" calls Claude from the server: point it at the fake, with a key that is not real and must never reach a browser.
  serverEnv.ANTHROPIC_API_KEY = "sk-ant-contract-key-not-real-7d1f";
  serverEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fakePort}`;
  serverEnv.ADMIN_EMAILS = ADMIN_EMAIL;
  const fixtures: Fixtures = {
    a,
    b,
    password: PASSWORD,
    suspended: { apiKey: skey, sessionToken: stok, email: "ct-suspended@example.test" },
    admin: { email: ADMIN_EMAIL, userId: au.id, workspaceId: at.id },
    connect: { email: cu.email, memberEmail: cm.email, workspaceId: ct.id },
    github,
    serverEnv,
  };
  fs.mkdirSync(path.dirname(path.resolve(out!)), { recursive: true });
  fs.writeFileSync(out!, JSON.stringify(fixtures, null, 2));

  // Close cleanly so PGlite flushes before the server opens the same directory.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (db as any).$client ?? (globalThis as any).__wheelhouseDb?.db?.$client;
  await client?.close?.(); // PGlite
  await client?.end?.(); // postgres-js
  console.log(`seeded ${databaseUrl ? "a Postgres database" : dir} -> ${out}`);
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
