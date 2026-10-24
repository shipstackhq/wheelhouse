import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { WORKSPACE_SUSPENDED_MESSAGE, userWorkspaceSuspended } from "./access";
import { passwordProblem, signupOpen } from "./auth-policy";
import { hashPassword, verifyPassword } from "./auth-core";
import { newWorkspaceSlug } from "./workspace-slug";
import { minutes, rateLimit, resetRateLimit } from "../../common/rate-limit";

/**
 * Creating an account and signing in: the rules, with no HTTP in them. The Next server actions and the API call these, so
 * the messages and the rate limits are the same everywhere. The host starts the session afterwards (auth-core startSession).
 */

export class AccountError extends Error {
  constructor(
    public code: "invalid" | "conflict" | "unauthorized" | "forbidden" | "signup_closed" | "team_suspended" | "rate_limited",
    message: string,
    public opts: { fields?: Record<string, string>; retryAfter?: number } = {},
  ) {
    super(message);
  }
  get status() {
    return { invalid: 400, conflict: 409, unauthorized: 401, forbidden: 403, signup_closed: 403, team_suspended: 403, rate_limited: 429 }[this.code];
  }
  get fields() {
    return this.opts.fields;
  }
  get retryAfter() {
    return this.opts.retryAfter;
  }
}

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const tooMany = (retryAfter: number) =>
  new AccountError("rate_limited", `Too many attempts. Try again in ${minutes(retryAfter)} minute${minutes(retryAfter) === 1 ? "" : "s"}.`, { retryAfter });

/** Whether the signup page and action are open (see auth-policy.ts). */
export async function signupAllowed() {
  const db = await getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
  return signupOpen({ allowSignup: process.env.ALLOW_SIGNUP, nodeEnv: process.env.NODE_ENV, userCount: n });
}

/** Create a user and a workspace they own. Throws AccountError. `ip` only feeds the signup rate limit. */
export async function signUp(input: { name: string; email: string; password: string; workspace?: string }, ip: string): Promise<{ userId: string }> {
  if (!(await signupAllowed())) throw new AccountError("signup_closed", "Signups are closed. Ask a workspace owner to add you.");
  const ipHit = rateLimit(`signup:${ip}`, 10, 60 * 60_000);
  if (!ipHit.ok) throw tooMany(ipHit.retryAfter);
  const name = String(input.name ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  const workspaceName = String(input.workspace ?? "").trim() || `${name}'s workspace`;
  if (!name || !emailOk(email)) {
    const fields: Record<string, string> = {};
    if (!name) fields.name = "Enter your name";
    if (!emailOk(email)) fields.email = "Enter a valid email";
    throw new AccountError("invalid", "Enter your name and a valid email", { fields });
  }
  const weak = passwordProblem(password);
  if (weak) throw new AccountError("invalid", weak, { fields: { password: weak } });

  const db = await getDb();
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (exists) throw new AccountError("conflict", "An account with that email already exists", { fields: { email: "An account with that email already exists" } });

  const passwordHash = await hashPassword(password);
  const userId = await db.transaction(async (tx) => {
    const [u] = await tx.insert(schema.users).values({ email, name, passwordHash }).returning();
    const [t] = await tx.insert(schema.workspaces).values({ name: workspaceName, slug: await newWorkspaceSlug(tx, workspaceName) }).returning();
    await tx.insert(schema.memberships).values({ userId: u.id, workspaceId: t.id, role: "owner" });
    return u.id;
  });
  return { userId };
}

/** Check an email and password. Throws AccountError. Rate limited per address and per account. */
export async function logIn(input: { email: string; password: string }, ip: string): Promise<{ userId: string }> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  // Per address (spraying many accounts) and per account (guessing one password from many addresses).
  const ipHit = rateLimit(`login-ip:${ip}`, 30, 15 * 60_000);
  if (!ipHit.ok) throw tooMany(ipHit.retryAfter);
  const emailHit = rateLimit(`login-email:${email}`, 8, 15 * 60_000);
  if (!emailHit.ok) throw tooMany(emailHit.retryAfter);
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!u || !(await verifyPassword(password, u.passwordHash))) throw new AccountError("unauthorized", "Invalid email or password");
  resetRateLimit(`login-email:${email}`);
  // Only someone who knows the password learns the workspace is suspended.
  if (await userWorkspaceSuspended(u.id)) throw new AccountError("team_suspended", WORKSPACE_SUSPENDED_MESSAGE);
  return { userId: u.id };
}
