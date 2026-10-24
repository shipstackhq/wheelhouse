import { Inject, Injectable } from "@nestjs/common";
import { sha256, randomToken } from "../../common/crypto";
import type { Actor } from "../../common/actor";
import { rateLimit, resetRateLimit } from "../../common/rate-limit";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import type { MembershipRow, UserRow, WorkspaceRowT } from "./auth.repository";
import { AuthRepository } from "./auth.repository";
import { Database } from "../../platform/database/database";
import { AccountError, AuthError, WORKSPACE_SUSPENDED_MESSAGE } from "./auth-errors";
import { SESSION_DAYS, signupOpen, passwordProblem } from "./auth-policy";
import { hashPassword, verifyPassword } from "./passwords";
import { KeysService } from "./keys.service";
import { emailOk, tooMany } from "./auth.rules";

/** The signed-in person: their user, the workspace they work in and their membership in it, and the actor the work is done as. */
export type Human = { user: UserRow; workspace: WorkspaceRowT; membership: MembershipRow; actor: Actor };

/**
 * Sign-in, sign-up, sessions, the workspace a session works in, and the person's own password. The rules (who is locked out, the
 * rate limits, the messages) live here; every query goes through AuthRepository. Credentials are checked by `actorFromCredentials`
 * (a key or a session), which the guards and the stream call.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuthRepository) private readonly repo: AuthRepository,
    @Inject(KeysService) private readonly keys: KeysService,
  ) {}

  /** Whether every workspace the user belongs to is suspended by an instance admin (WH-52). One suspended workspace is simply not offered. */
  async userWorkspaceSuspended(userId: string) {
    const rows = await this.repo.suspensionsOf(userId);
    return rows.length > 0 && rows.every((r) => !!r.at);
  }

  /**
   * The signed-in user behind a session cookie value, with the workspace the session is working in (or null for "their first"), or
   * null when signed out. A person whose every workspace is suspended counts as signed out even if a session row still exists.
   */
  async sessionForToken(token: string, now = new Date()) {
    const row = await this.repo.sessionRow(sha256(token), now);
    if (!row) return null;
    if (await this.userWorkspaceSuspended(row.user.id)) return null;
    return row;
  }

  async userForSessionToken(token: string, now = new Date()) {
    return (await this.sessionForToken(token, now))?.user ?? null;
  }

  /**
   * The workspace a person is working in: the one their session chose, else their first. A suspended workspace is never chosen. Null
   * when they belong to none that is usable.
   */
  async currentMembership(userId: string, activeWorkspaceId?: string | null) {
    const rows = await this.repo.membershipsOf(userId);
    const usable = rows.filter((r) => !r.workspace.suspendedAt);
    return usable.find((r) => r.workspace.id === activeWorkspaceId) ?? usable[0] ?? null;
  }

  /** Every workspace the person can work in, for the switcher; `active` marks the current one. */
  async listWorkspaces(userId: string, activeWorkspaceId?: string | null) {
    const cur = await this.currentMembership(userId, activeWorkspaceId);
    const rows = await this.repo.membershipsOf(userId);
    return rows
      .filter((r) => !r.workspace.suspendedAt)
      .map((r) => ({ id: r.workspace.id, name: r.workspace.name, role: r.membership.role, active: r.workspace.id === cur?.workspace.id }));
  }

  /** Points this session at another of the person's workspaces. Refused for one they are not in or that is suspended. */
  async switchWorkspace(token: string, userId: string, workspaceId: string) {
    if (!isUuid(workspaceId)) return null;
    const m = await this.repo.membershipIn(userId, workspaceId);
    if (!m || m.workspace.suspendedAt) return null;
    await this.repo.setActiveWorkspace(sha256(token), userId, workspaceId);
    return { id: m.workspace.id, name: m.workspace.name };
  }

  /**
   * `Authorization: Bearer wh_...` (agents) wins over a session cookie (people using the API from the browser). Throws AuthError (401),
   * SuspendedError (403) or RateLimitError (429).
   */
  async actorFromCredentials(c: { authorization?: string | null; sessionToken?: string | null; ip: string }): Promise<Actor> {
    if (c.authorization?.startsWith("Bearer ")) return this.keys.actorForKey(c.authorization.slice(7).trim(), c.ip);
    const session = c.sessionToken ? await this.sessionForToken(c.sessionToken) : null;
    if (!session) throw new AuthError("Not authenticated");
    const user = session.user;
    const m = await this.currentMembership(user.id, session.activeWorkspaceId);
    if (!m) throw new AuthError("No workspace");
    return { kind: "human", id: user.id, name: user.name, workspaceId: m.workspace.id };
  }

  /** The person behind a session cookie, with their workspace and membership, or null when signed out. */
  async humanFromSession(token: string | undefined | null): Promise<Human | null> {
    const session = token ? await this.sessionForToken(token) : null;
    if (!session) return null;
    const user = session.user;
    const m = await this.currentMembership(user.id, session.activeWorkspaceId);
    if (!m) return null;
    const actor: Actor = { kind: "human", id: user.id, name: user.name, workspaceId: m.workspace.id };
    return { user, workspace: m.workspace, membership: m.membership, actor };
  }

  /** Starts a session: a random token for the caller to put in the cookie; only its sha256 is stored. */
  async startSession(userId: string) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
    await this.repo.insertSession(sha256(token), userId, expiresAt);
    return { token, expiresAt };
  }

  /** Ends a session by its cookie value. Harmless if there is none or it is already gone. */
  async endSession(token: string | undefined | null) {
    if (!token) return;
    await this.repo.deleteSession(sha256(token));
  }

  /**
   * Starts a session for a person who has just proved who they are (sign in, sign up, accepting an invite). `setCookie` writes the
   * cookie; the answer is the signed-in person and the token, for the caller to present.
   */
  async begin(userId: string, setCookie: (token: string, expiresAt: Date) => void) {
    const { token, expiresAt } = await this.startSession(userId);
    setCookie(token, expiresAt);
    const human = await this.humanFromSession(token);
    if (!human) throw new AccountError("unauthorized", "Could not start a session");
    return { human, token };
  }

  /** Whether the signup page and action are open (see auth-policy.ts). */
  async signupAllowed() {
    const n = await this.repo.userCount();
    return signupOpen({ allowSignup: process.env.ALLOW_SIGNUP, nodeEnv: process.env.NODE_ENV, userCount: n });
  }

  /** Create a user and a workspace they own. Throws AccountError. `ip` only feeds the signup rate limit. */
  async signUp(input: { name: string; email: string; password: string; workspace?: string }, ip: string): Promise<{ userId: string }> {
    if (!(await this.signupAllowed())) throw new AccountError("signup_closed", "Signups are closed. Ask a workspace owner to add you.");
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

    if (await this.repo.userByEmail(email)) throw new AccountError("conflict", "An account with that email already exists", { fields: { email: "An account with that email already exists" } });

    const passwordHash = await hashPassword(password);
    const userId = await this.db.transaction(async () => {
      const u = await this.repo.insertUser({ email, name, passwordHash });
      const t = await this.repo.insertWorkspace(workspaceName);
      await this.repo.insertMembership({ userId: u.id, workspaceId: t.id, role: "owner" });
      return u.id;
    });
    return { userId };
  }

  /** Check an email and password. Throws AccountError. Rate limited per address and per account. */
  async logIn(input: { email: string; password: string }, ip: string): Promise<{ userId: string }> {
    const email = String(input.email ?? "").trim().toLowerCase();
    const password = String(input.password ?? "");
    // Per address (spraying many accounts) and per account (guessing one password from many addresses).
    const ipHit = rateLimit(`login-ip:${ip}`, 30, 15 * 60_000);
    if (!ipHit.ok) throw tooMany(ipHit.retryAfter);
    const emailHit = rateLimit(`login-email:${email}`, 8, 15 * 60_000);
    if (!emailHit.ok) throw tooMany(emailHit.retryAfter);
    const u = await this.repo.userByEmail(email);
    if (!u || !(await verifyPassword(password, u.passwordHash))) throw new AccountError("unauthorized", "Invalid email or password");
    resetRateLimit(`login-email:${email}`);
    // Only someone who knows the password learns the workspace is suspended.
    if (await this.userWorkspaceSuspended(u.id)) throw new AccountError("team_suspended", WORKSPACE_SUSPENDED_MESSAGE);
    return { userId: u.id };
  }

  /** The signed-in person changes their own password; the current one must be right. */
  async changePasswordAs(h: Human, input: { current: string; next: string }) {
    const weak = passwordProblem(input.next);
    if (weak) throw new ServiceError("invalid", weak, { fields: { next: weak } });
    if (!(await verifyPassword(input.current, h.user.passwordHash))) {
      throw new ServiceError("invalid", "Current password is wrong", { fields: { current: "Current password is wrong" } });
    }
    await this.repo.setPasswordHash(h.user.id, await hashPassword(input.next));
    return { ok: true as const };
  }
}
