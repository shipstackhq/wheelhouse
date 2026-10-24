import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "../../db";
import { inviteTtlHours, isInstanceAdmin, maxWorkspaceMembers, passwordProblem } from "./auth-policy";
import type { TeamRole, WorkspaceRole } from "../../db/schema";
import { audit } from "../teams/team-access";
import { canManagePeople, isWorkspaceRole } from "../../common/roles";
import { requireTeam } from "../../lib/service";
import { newWorkspaceSlug } from "./workspace-slug";

/**
 * Invite-only signup (WH-49).
 *  - A link carries a 256-bit random token. Only its SHA-256 is stored.
 *  - An invite is bound to one email, one kind (new_workspace | join_workspace), one workspace and one role. The accept
 *    path takes none of those from the client.
 *  - Acceptance claims the invite with one guarded UPDATE inside the transaction that creates the
 *    account, so two simultaneous accepts cannot both win. A join invite also locks its workspace row to
 *    check the seat limit, so concurrent accepts cannot overshoot it.
 *  - Failures at acceptance all look the same to the caller (INVITE_INVALID); `reason` is for tests and logs.
 */

export const INVITE_INVALID = "This invite link is invalid or has expired.";

export type InviteFailureReason = "invalid" | "workspace_full" | "account_exists";

/** Acceptance failure. `message` is always the generic text, whatever the reason. */
export class InviteFailure extends Error {
  constructor(public reason: InviteFailureReason) {
    super(INVITE_INVALID);
  }
}

/** A problem the person issuing an invite can be told about (they are signed in and authorised). */
export class InviteError extends Error {
  constructor(
    public code: "invalid" | "forbidden" | "conflict" | "workspace_full" | "not_found" | "weak_password",
    message: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
const { invites, users, workspaces, memberships } = schema;

export type Issuer = { userId: string; email: string; workspaceId: string; role: WorkspaceRole };
export type NewInvite = { id: string; token: string; email: string; kind: "new_workspace" | "join_workspace"; expiresAt: Date };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const emailOk = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const normalizeEmail = (e: string) => e.trim().toLowerCase();

const pending = (now: Date) => and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now));

async function memberCount(tx: Tx | DB, workspaceId: string) {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, workspaceId));
  return r.n;
}

async function pendingJoinCount(tx: Tx | DB, workspaceId: string, now: Date) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(invites)
    .where(and(eq(invites.kind, "join_workspace"), eq(invites.workspaceId, workspaceId), pending(now)));
  return r.n;
}

/** Seats of a workspace: members plus pending join invites, against the limit. */
export async function seatInfo(workspaceId: string, now = new Date()) {
  const db = await getDb();
  const members = await memberCount(db, workspaceId);
  const pendingInvites = await pendingJoinCount(db, workspaceId, now);
  const max = maxWorkspaceMembers();
  return { members, pending: pendingInvites, used: members + pendingInvites, max, full: members + pendingInvites >= max };
}

/** Create an invite. Returns the plain token once; it cannot be recovered later. */
export async function createInvite(
  issuer: Issuer,
  input: { kind: "new_workspace" | "join_workspace"; email: string; role?: WorkspaceRole; tags?: string[]; workspaceName?: string; teams?: { team: string; role: TeamRole }[] },
  now = new Date(),
): Promise<NewInvite> {
  const email = normalizeEmail(input.email);
  if (!emailOk(email)) throw new InviteError("invalid", "Enter a valid email address");
  if (input.kind === "new_workspace") {
    if (!isInstanceAdmin(issuer.email)) throw new InviteError("forbidden", "Only instance admins can invite someone to a new workspace");
  } else if (!canManagePeople(issuer.role)) {
    throw new InviteError("forbidden", "Only workspace owners and admins can invite members");
  }
  const wanted = input.role ?? "member";
  if (!isWorkspaceRole(wanted)) throw new InviteError("invalid", "Choose a role: owner, admin, member, viewer or guest");
  if (input.kind === "join_workspace" && wanted === "owner" && issuer.role !== "owner") throw new InviteError("forbidden", "Only an owner can invite another owner");
  // Teams to put the person into on accept (ADR-23). The issuer must be an admin of each one: you cannot give away a team you do not run.
  const grants: { teamId: string; role: TeamRole }[] = [];
  if (input.kind === "join_workspace" && input.teams?.length) {
    if (input.teams.length > 20) throw new InviteError("invalid", "An invite can add someone to at most 20 teams");
    const who = { kind: "human" as const, id: issuer.userId, name: issuer.email, workspaceId: issuer.workspaceId };
    for (const g of input.teams) {
      if (!(["admin", "editor", "viewer"] as const).includes(g.role)) throw new InviteError("invalid", "Choose a team role: admin, editor or viewer");
      let p;
      try {
        p = await requireTeam(who, g.team, "admin");
      } catch {
        throw new InviteError("forbidden", `You can only add people to teams you administer (${g.team})`);
      }
      if (!grants.some((x) => x.teamId === p.id)) grants.push({ teamId: p.id, role: g.role });
    }
  }
  const workspaceName = input.kind === "new_workspace" ? (input.workspaceName ?? "").trim().slice(0, 100) || null : null;
  const role = input.kind === "join_workspace" ? wanted : "member";
  const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 20);

  const db = await getDb();
  // Only an instance admin may learn that an address already has an account. A workspace owner must not be able to
  // probe which emails are registered on the server (possibly in other workspaces), so for them the invite is created
  // either way; if the address already has an account, accepting the link simply fails like any invalid link.
  if (input.kind === "new_workspace") {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new InviteError("conflict", "An account with that email already exists");
  }

  const token = newToken();
  const expiresAt = new Date(now.getTime() + inviteTtlHours() * 3_600_000);
  const row = await db.transaction(async (tx) => {
    if (input.kind === "join_workspace") {
      // Lock the workspace so two owners (or two tabs) cannot both take the last seat.
      const [t] = await tx.select({ suspendedAt: workspaces.suspendedAt }).from(workspaces).where(eq(workspaces.id, issuer.workspaceId)).for("update");
      if (t?.suspendedAt) throw new InviteError("forbidden", "This workspace has been suspended. Contact the administrator.");
      const used = (await memberCount(tx, issuer.workspaceId)) + (await pendingJoinCount(tx, issuer.workspaceId, now));
      const max = maxWorkspaceMembers();
      if (used >= max) {
        throw new InviteError(
          "workspace_full",
          `Your workspace is full (${used} of ${max} seats used, counting pending invites). Revoke an invite or remove a member.`,
        );
      }
    }
    const scope = input.kind === "join_workspace" ? eq(invites.workspaceId, issuer.workspaceId) : isNull(invites.workspaceId);
    const [dup] = await tx
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.kind, input.kind), eq(invites.email, email), scope, pending(now)));
    if (dup) throw new InviteError("conflict", "That email already has a pending invite. Revoke it first to send a new one.");

    const [r] = await tx
      .insert(invites)
      .values({
        kind: input.kind,
        email,
        workspaceId: input.kind === "join_workspace" ? issuer.workspaceId : null,
        workspaceName,
        role,
        tags,
        tokenHash: sha256(token),
        createdBy: issuer.userId,
        expiresAt,
      })
      .returning({ id: invites.id });
    if (grants.length && input.kind === "join_workspace") {
      await tx.insert(schema.inviteTeams).values(grants.map((g) => ({ inviteId: r.id, teamId: g.teamId, workspaceId: issuer.workspaceId, role: g.role })));
    }
    return r;
  });
  console.info(`[invite] created ${row.id} kind=${input.kind} by=${issuer.userId}`);
  return { id: row.id, token, email, kind: input.kind, expiresAt };
}

export type PendingInvite = {
  id: string;
  kind: "new_workspace" | "join_workspace";
  email: string;
  role: WorkspaceRole;
  workspaceName: string | null;
  /** The teams they join on accepting, by key. */
  teams: { key: string; name: string; role: TeamRole }[];
  createdAt: Date;
  expiresAt: Date;
};

/** Pending invites the issuer may see: their workspace's join invites (owners) and new-workspace invites (admins). */
export async function listInvites(issuer: Issuer, now = new Date()): Promise<PendingInvite[]> {
  const scopes = [];
  if (canManagePeople(issuer.role)) scopes.push(and(eq(invites.kind, "join_workspace"), eq(invites.workspaceId, issuer.workspaceId)));
  if (isInstanceAdmin(issuer.email)) scopes.push(eq(invites.kind, "new_workspace"));
  if (!scopes.length) return [];
  const db = await getDb();
  return db
    .select({
      id: invites.id,
      kind: invites.kind,
      email: invites.email,
      role: invites.role,
      workspaceName: invites.workspaceName,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .where(and(pending(now), or(...scopes)))
    .orderBy(invites.createdAt)
    .then(async (rows) => {
      const granted = rows.length
        ? await db
            .select({ inviteId: schema.inviteTeams.inviteId, key: schema.teams.key, name: schema.teams.name, role: schema.inviteTeams.role })
            .from(schema.inviteTeams)
            .innerJoin(schema.teams, eq(schema.teams.id, schema.inviteTeams.teamId))
            .where(inArray(schema.inviteTeams.inviteId, rows.map((r) => r.id)))
            .orderBy(schema.teams.key)
        : [];
      return rows.map((r) => ({ ...r, teams: granted.filter((g) => g.inviteId === r.id).map(({ key, name, role }) => ({ key, name, role })) }));
    });
}

export async function revokeInvite(issuer: Issuer, id: string, now = new Date()) {
  const scopes = [];
  if (canManagePeople(issuer.role)) scopes.push(and(eq(invites.kind, "join_workspace"), eq(invites.workspaceId, issuer.workspaceId)));
  if (isInstanceAdmin(issuer.email)) scopes.push(eq(invites.kind, "new_workspace"));
  if (!scopes.length) throw new InviteError("forbidden", "Only workspace owners and admins can revoke invites");
  const db = await getDb();
  const rows = await db
    .update(invites)
    .set({ revokedAt: now })
    .where(and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt), or(...scopes)))
    .returning({ id: invites.id });
  if (!rows.length) throw new InviteError("not_found", "That invite was not found or has already been used");
  console.info(`[invite] revoked ${id} by=${issuer.userId}`);
}

/** What the invite page shows before the person picks a password. null for every kind of bad link. */
export async function peekInvite(token: string, now = new Date()) {
  if (!TOKEN_RE.test(token)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ email: invites.email, kind: invites.kind, workspaceName: invites.workspaceName, workspaceId: invites.workspaceId })
    .from(invites)
    .where(and(eq(invites.tokenHash, sha256(token)), pending(now)));
  if (!row) return null;
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.email));
  if (taken) return null;
  let workspaceName = row.workspaceName;
  if (row.kind === "join_workspace" && row.workspaceId) {
    const [t] = await db.select({ name: workspaces.name, suspendedAt: workspaces.suspendedAt }).from(workspaces).where(eq(workspaces.id, row.workspaceId));
    if (!t || t.suspendedAt) return null;
    workspaceName = t.name;
  }
  return { email: row.email, kind: row.kind, workspaceName };
}

/**
 * Put the person into the teams the inviter chose, as long as each still belongs to the workspace. One audit line each, in the
 * inviter's name. Shared by a new account accepting and an existing account accepting.
 */
async function grantInviteTeams(tx: Tx, inv: typeof invites.$inferSelect, userId: string, workspaceId: string) {
  const grants = await tx.select().from(schema.inviteTeams).where(eq(schema.inviteTeams.inviteId, inv.id));
  if (!grants.length) return;
  const [issuer] = inv.createdBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, inv.createdBy)) : [];
  for (const g of grants) {
    const [p] = await tx.select({ id: schema.teams.id }).from(schema.teams).where(and(eq(schema.teams.id, g.teamId), eq(schema.teams.workspaceId, workspaceId)));
    if (!p) continue;
    await tx.insert(schema.teamMembers).values({ teamId: p.id, userId, workspaceId, role: g.role, addedBy: inv.createdBy }).onConflictDoNothing();
    await audit(tx, { kind: "human", id: inv.createdBy ?? userId, name: issuer?.name ?? "An invite", workspaceId }, { action: "team.member_added", targetType: "user", targetId: userId, teamId: p.id, after: { role: g.role, via: "invite" } });
  }
}

const isUniqueViolation = (e: unknown) => {
  const x = e as { code?: string; cause?: { code?: string }; message?: string };
  return x?.code === "23505" || x?.cause?.code === "23505" || /duplicate key|unique constraint/i.test(x?.message ?? "");
};

/**
 * Consume an invite and create the account. Returns the new user id; the caller starts the session.
 * Throws InviteError for a weak password or name (nothing about the token is revealed) and
 * InviteFailure for every problem with the invite itself.
 */
export async function acceptInvite(input: { token: string; name: string; password: string }, now = new Date()) {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new InviteError("invalid", "Enter your name");
  const weak = passwordProblem(input.password);
  if (weak) throw new InviteError("weak_password", weak);
  if (!TOKEN_RE.test(input.token)) throw new InviteFailure("invalid");

  const tokenHash = sha256(input.token);
  const passwordHash = await bcrypt.hash(input.password, 10); // slow: done before the transaction holds any lock
  const db = await getDb();
  try {
    return await db.transaction(async (tx) => {
      const [inv] = await tx.select().from(invites).where(and(eq(invites.tokenHash, tokenHash), pending(now)));
      if (!inv) throw new InviteFailure("invalid");

      if (inv.kind === "join_workspace") {
        if (!inv.workspaceId) throw new InviteFailure("invalid");
        const [t] = await tx.select({ suspendedAt: workspaces.suspendedAt }).from(workspaces).where(eq(workspaces.id, inv.workspaceId)).for("update");
        if (!t || t.suspendedAt) throw new InviteFailure("invalid"); // a suspended workspace's invites are inert
        if ((await memberCount(tx, inv.workspaceId)) >= maxWorkspaceMembers()) throw new InviteFailure("workspace_full");
      }

      // The claim: succeeds for exactly one caller, whatever the concurrency.
      const claimed = await tx
        .update(invites)
        .set({ usedAt: now })
        .where(and(eq(invites.id, inv.id), pending(now)))
        .returning({ id: invites.id });
      if (!claimed.length) throw new InviteFailure("invalid");

      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
      if (taken) throw new InviteFailure("account_exists");
      const [u] = await tx.insert(users).values({ email: inv.email, name, passwordHash }).returning({ id: users.id });

      let workspaceId = inv.workspaceId;
      if (inv.kind === "new_workspace") {
        const workspaceName = inv.workspaceName || `${name}'s workspace`;
        const [t] = await tx.insert(workspaces).values({ name: workspaceName, slug: await newWorkspaceSlug(tx, workspaceName) }).returning({ id: workspaces.id });
        workspaceId = t.id;
        await tx.insert(memberships).values({ userId: u.id, workspaceId, role: "owner" });
      } else {
        await tx.insert(memberships).values({ userId: u.id, workspaceId: workspaceId!, role: inv.role, tags: inv.tags });
      }
      if (inv.kind === "join_workspace") await grantInviteTeams(tx, inv, u.id, workspaceId!);
      await tx.update(invites).set({ usedBy: u.id }).where(eq(invites.id, inv.id));
      console.info(`[invite] accepted ${inv.id} kind=${inv.kind}`);
      return { userId: u.id, workspaceId: workspaceId!, kind: inv.kind };
    });
  } catch (e) {
    if (e instanceof InviteFailure || e instanceof InviteError) throw e;
    if (isUniqueViolation(e)) throw new InviteFailure("account_exists");
    throw e;
  }
}

/**
 * What a signed-in person is being invited to, when the invite was sent to their own email and they already have an account
 * (they will join another workspace with it). Anything else, including an invite for someone else's address, is null: the same
 * answer as for any bad link.
 */
export async function peekInviteAsMember(user: { email: string }, token: string, now = new Date()) {
  if (!TOKEN_RE.test(token)) return null;
  const db = await getDb();
  const [row] = await db.select().from(invites).where(and(eq(invites.tokenHash, sha256(token)), pending(now)));
  if (!row || row.kind !== "join_workspace" || !row.workspaceId || row.email !== normalizeEmail(user.email)) return null;
  const [t] = await db.select({ name: workspaces.name, suspendedAt: workspaces.suspendedAt }).from(workspaces).where(eq(workspaces.id, row.workspaceId));
  if (!t || t.suspendedAt) return null;
  const granted = await db
    .select({ key: schema.teams.key, name: schema.teams.name, role: schema.inviteTeams.role })
    .from(schema.inviteTeams)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.inviteTeams.teamId))
    .where(eq(schema.inviteTeams.inviteId, row.id))
    .orderBy(schema.teams.key);
  return { email: row.email, workspaceName: t.name, role: row.role, teams: granted };
}

/**
 * A signed-in person with an account accepts a join invite sent to their own email: they become a member of that workspace
 * (and of the teams chosen) and keep their account, so one person can work in several workspaces. Throws InviteFailure
 * for every problem with the invite, and "already_member" for someone who is in the workspace already (the invite stays unused).
 */
export async function acceptInviteAsMember(user: { id: string; email: string }, token: string, now = new Date()) {
  if (!TOKEN_RE.test(token)) throw new InviteFailure("invalid");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invites).where(and(eq(invites.tokenHash, sha256(token)), pending(now)));
    if (!inv || inv.kind !== "join_workspace" || !inv.workspaceId || inv.email !== normalizeEmail(user.email)) throw new InviteFailure("invalid");
    const [t] = await tx.select({ suspendedAt: workspaces.suspendedAt }).from(workspaces).where(eq(workspaces.id, inv.workspaceId)).for("update");
    if (!t || t.suspendedAt) throw new InviteFailure("invalid");
    const [already] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, inv.workspaceId), eq(memberships.userId, user.id)));
    if (already) throw new InviteError("conflict", "You are already in this workspace");
    if ((await memberCount(tx, inv.workspaceId)) >= maxWorkspaceMembers()) throw new InviteFailure("workspace_full");
    const claimed = await tx.update(invites).set({ usedAt: now, usedBy: user.id }).where(and(eq(invites.id, inv.id), pending(now))).returning({ id: invites.id });
    if (!claimed.length) throw new InviteFailure("invalid");
    await tx.insert(memberships).values({ userId: user.id, workspaceId: inv.workspaceId, role: inv.role, tags: inv.tags });
    await grantInviteTeams(tx, inv, user.id, inv.workspaceId);
    console.info(`[invite] accepted ${inv.id} kind=join_workspace by an existing account`);
    return { workspaceId: inv.workspaceId };
  });
}
