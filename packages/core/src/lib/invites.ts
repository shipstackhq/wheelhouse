import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "../db";
import { inviteTtlHours, isInstanceAdmin, maxTeamMembers, passwordProblem } from "./auth-policy";
import type { ProjectRole, WorkspaceRole } from "../db/schema";
import { audit, canManagePeople, isWorkspaceRole } from "./project-access";
import { getProject } from "./service";

/**
 * Invite-only signup (WH-49).
 *  - A link carries a 256-bit random token. Only its SHA-256 is stored.
 *  - An invite is bound to one email, one kind (new_team | join_team), one team and one role. The accept
 *    path takes none of those from the client.
 *  - Acceptance claims the invite with one guarded UPDATE inside the transaction that creates the
 *    account, so two simultaneous accepts cannot both win. A join invite also locks its team row to
 *    check the seat limit, so concurrent accepts cannot overshoot it.
 *  - Failures at acceptance all look the same to the caller (INVITE_INVALID); `reason` is for tests and logs.
 */

export const INVITE_INVALID = "This invite link is invalid or has expired.";

export type InviteFailureReason = "invalid" | "team_full" | "account_exists";

/** Acceptance failure. `message` is always the generic text, whatever the reason. */
export class InviteFailure extends Error {
  constructor(public reason: InviteFailureReason) {
    super(INVITE_INVALID);
  }
}

/** A problem the person issuing an invite can be told about (they are signed in and authorised). */
export class InviteError extends Error {
  constructor(
    public code: "invalid" | "forbidden" | "conflict" | "team_full" | "not_found" | "weak_password",
    message: string,
  ) {
    super(message);
  }
}

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
const { invites, users, teams, memberships } = schema;

export type Issuer = { userId: string; email: string; teamId: string; role: WorkspaceRole };
export type NewInvite = { id: string; token: string; email: string; kind: "new_team" | "join_team"; expiresAt: Date };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const emailOk = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const normalizeEmail = (e: string) => e.trim().toLowerCase();

const pending = (now: Date) => and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now));

async function memberCount(tx: Tx | DB, teamId: string) {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.teamId, teamId));
  return r.n;
}

async function pendingJoinCount(tx: Tx | DB, teamId: string, now: Date) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(invites)
    .where(and(eq(invites.kind, "join_team"), eq(invites.teamId, teamId), pending(now)));
  return r.n;
}

/** Seats of a team: members plus pending join invites, against the limit. */
export async function seatInfo(teamId: string, now = new Date()) {
  const db = await getDb();
  const members = await memberCount(db, teamId);
  const pendingInvites = await pendingJoinCount(db, teamId, now);
  const max = maxTeamMembers();
  return { members, pending: pendingInvites, used: members + pendingInvites, max, full: members + pendingInvites >= max };
}

/** Create an invite. Returns the plain token once; it cannot be recovered later. */
export async function createInvite(
  issuer: Issuer,
  input: { kind: "new_team" | "join_team"; email: string; role?: WorkspaceRole; tags?: string[]; teamName?: string; projects?: { project: string; role: ProjectRole }[] },
  now = new Date(),
): Promise<NewInvite> {
  const email = normalizeEmail(input.email);
  if (!emailOk(email)) throw new InviteError("invalid", "Enter a valid email address");
  if (input.kind === "new_team") {
    if (!isInstanceAdmin(issuer.email)) throw new InviteError("forbidden", "Only instance admins can invite someone to a new workspace");
  } else if (!canManagePeople(issuer.role)) {
    throw new InviteError("forbidden", "Only workspace owners and admins can invite members");
  }
  const wanted = input.role ?? "member";
  if (!isWorkspaceRole(wanted)) throw new InviteError("invalid", "Choose a role: owner, admin, member, viewer or guest");
  if (input.kind === "join_team" && wanted === "owner" && issuer.role !== "owner") throw new InviteError("forbidden", "Only an owner can invite another owner");
  // Projects to put the person into on accept (ADR-23). The issuer must be an admin of each one: you cannot give away a project you do not run.
  const grants: { projectId: string; role: ProjectRole }[] = [];
  if (input.kind === "join_team" && input.projects?.length) {
    if (input.projects.length > 20) throw new InviteError("invalid", "An invite can add someone to at most 20 projects");
    const who = { kind: "human" as const, id: issuer.userId, name: issuer.email, teamId: issuer.teamId };
    for (const g of input.projects) {
      if (!(["admin", "editor", "viewer"] as const).includes(g.role)) throw new InviteError("invalid", "Choose a project role: admin, editor or viewer");
      let p;
      try {
        p = await getProject(who, g.project, "admin");
      } catch {
        throw new InviteError("forbidden", `You can only add people to projects you administer (${g.project})`);
      }
      if (!grants.some((x) => x.projectId === p.id)) grants.push({ projectId: p.id, role: g.role });
    }
  }
  const teamName = input.kind === "new_team" ? (input.teamName ?? "").trim().slice(0, 100) || null : null;
  const role = input.kind === "join_team" ? wanted : "member";
  const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 20);

  const db = await getDb();
  // Only an instance admin may learn that an address already has an account. A team owner must not be able to
  // probe which emails are registered on the server (possibly in other teams), so for them the invite is created
  // either way; if the address already has an account, accepting the link simply fails like any invalid link.
  if (input.kind === "new_team") {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing) throw new InviteError("conflict", "An account with that email already exists");
  }

  const token = newToken();
  const expiresAt = new Date(now.getTime() + inviteTtlHours() * 3_600_000);
  const row = await db.transaction(async (tx) => {
    if (input.kind === "join_team") {
      // Lock the team so two owners (or two tabs) cannot both take the last seat.
      const [t] = await tx.select({ suspendedAt: teams.suspendedAt }).from(teams).where(eq(teams.id, issuer.teamId)).for("update");
      if (t?.suspendedAt) throw new InviteError("forbidden", "This team has been suspended. Contact the administrator.");
      const used = (await memberCount(tx, issuer.teamId)) + (await pendingJoinCount(tx, issuer.teamId, now));
      const max = maxTeamMembers();
      if (used >= max) {
        throw new InviteError(
          "team_full",
          `Your workspace is full (${used} of ${max} seats used, counting pending invites). Revoke an invite or remove a member.`,
        );
      }
    }
    const scope = input.kind === "join_team" ? eq(invites.teamId, issuer.teamId) : isNull(invites.teamId);
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
        teamId: input.kind === "join_team" ? issuer.teamId : null,
        teamName,
        role,
        tags,
        projects: grants,
        tokenHash: sha256(token),
        createdBy: issuer.userId,
        expiresAt,
      })
      .returning({ id: invites.id });
    return r;
  });
  console.info(`[invite] created ${row.id} kind=${input.kind} by=${issuer.userId}`);
  return { id: row.id, token, email, kind: input.kind, expiresAt };
}

export type PendingInvite = {
  id: string;
  kind: "new_team" | "join_team";
  email: string;
  role: WorkspaceRole;
  teamName: string | null;
  /** The projects they join on accepting, by key. */
  projects: { key: string; name: string; role: ProjectRole }[];
  createdAt: Date;
  expiresAt: Date;
};

/** Pending invites the issuer may see: their team's join invites (owners) and new-team invites (admins). */
export async function listInvites(issuer: Issuer, now = new Date()): Promise<PendingInvite[]> {
  const scopes = [];
  if (canManagePeople(issuer.role)) scopes.push(and(eq(invites.kind, "join_team"), eq(invites.teamId, issuer.teamId)));
  if (isInstanceAdmin(issuer.email)) scopes.push(eq(invites.kind, "new_team"));
  if (!scopes.length) return [];
  const db = await getDb();
  return db
    .select({
      id: invites.id,
      kind: invites.kind,
      email: invites.email,
      role: invites.role,
      teamName: invites.teamName,
      grants: invites.projects,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .where(and(pending(now), or(...scopes)))
    .orderBy(invites.createdAt)
    .then(async (rows) => {
      const ids = [...new Set(rows.flatMap((r) => r.grants.map((g) => g.projectId)))];
      const named = ids.length ? await db.select({ id: schema.projects.id, key: schema.projects.key, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, ids)) : [];
      return rows.map(({ grants, ...r }) => ({
        ...r,
        projects: grants.flatMap((g) => {
          const p = named.find((n) => n.id === g.projectId);
          return p ? [{ key: p.key, name: p.name, role: g.role }] : [];
        }),
      }));
    });
}

export async function revokeInvite(issuer: Issuer, id: string, now = new Date()) {
  const scopes = [];
  if (canManagePeople(issuer.role)) scopes.push(and(eq(invites.kind, "join_team"), eq(invites.teamId, issuer.teamId)));
  if (isInstanceAdmin(issuer.email)) scopes.push(eq(invites.kind, "new_team"));
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
    .select({ email: invites.email, kind: invites.kind, teamName: invites.teamName, teamId: invites.teamId })
    .from(invites)
    .where(and(eq(invites.tokenHash, sha256(token)), pending(now)));
  if (!row) return null;
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.email));
  if (taken) return null;
  let teamName = row.teamName;
  if (row.kind === "join_team" && row.teamId) {
    const [t] = await db.select({ name: teams.name, suspendedAt: teams.suspendedAt }).from(teams).where(eq(teams.id, row.teamId));
    if (!t || t.suspendedAt) return null;
    teamName = t.name;
  }
  return { email: row.email, kind: row.kind, teamName };
}

/**
 * Put the person into the projects the inviter chose, as long as each still belongs to the team. One audit line each, in the
 * inviter's name. Shared by a new account accepting and an existing account accepting.
 */
async function grantInviteProjects(tx: Tx, inv: typeof invites.$inferSelect, userId: string, teamId: string) {
  if (!inv.projects.length) return;
  const [issuer] = inv.createdBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, inv.createdBy)) : [];
  for (const g of inv.projects) {
    const [p] = await tx.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, g.projectId), eq(schema.projects.teamId, teamId)));
    if (!p) continue;
    await tx.insert(schema.projectMembers).values({ projectId: p.id, userId, teamId, role: g.role, addedBy: inv.createdBy }).onConflictDoNothing();
    await audit(tx, { kind: "human", id: inv.createdBy ?? userId, name: issuer?.name ?? "An invite", teamId }, { action: "project.member_added", targetType: "user", targetId: userId, projectId: p.id, after: { role: g.role, via: "invite" } });
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

      if (inv.kind === "join_team") {
        if (!inv.teamId) throw new InviteFailure("invalid");
        const [t] = await tx.select({ suspendedAt: teams.suspendedAt }).from(teams).where(eq(teams.id, inv.teamId)).for("update");
        if (!t || t.suspendedAt) throw new InviteFailure("invalid"); // a suspended team's invites are inert
        if ((await memberCount(tx, inv.teamId)) >= maxTeamMembers()) throw new InviteFailure("team_full");
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

      let teamId = inv.teamId;
      if (inv.kind === "new_team") {
        const [t] = await tx.insert(teams).values({ name: inv.teamName || `${name}'s team` }).returning({ id: teams.id });
        teamId = t.id;
        await tx.insert(memberships).values({ userId: u.id, teamId, role: "owner" });
      } else {
        await tx.insert(memberships).values({ userId: u.id, teamId: teamId!, role: inv.role, tags: inv.tags });
      }
      if (inv.kind === "join_team") await grantInviteProjects(tx, inv, u.id, teamId!);
      await tx.update(invites).set({ usedBy: u.id }).where(eq(invites.id, inv.id));
      console.info(`[invite] accepted ${inv.id} kind=${inv.kind}`);
      return { userId: u.id, teamId: teamId!, kind: inv.kind };
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
  if (!row || row.kind !== "join_team" || !row.teamId || row.email !== normalizeEmail(user.email)) return null;
  const [t] = await db.select({ name: teams.name, suspendedAt: teams.suspendedAt }).from(teams).where(eq(teams.id, row.teamId));
  if (!t || t.suspendedAt) return null;
  const named = row.projects.length
    ? await db.select({ id: schema.projects.id, key: schema.projects.key, name: schema.projects.name }).from(schema.projects).where(inArray(schema.projects.id, row.projects.map((g) => g.projectId)))
    : [];
  return {
    email: row.email,
    teamName: t.name,
    role: row.role,
    projects: row.projects.flatMap((g) => {
      const p = named.find((n) => n.id === g.projectId);
      return p ? [{ key: p.key, name: p.name, role: g.role }] : [];
    }),
  };
}

/**
 * A signed-in person with an account accepts a join invite sent to their own email: they become a member of that workspace
 * (and of the projects chosen) and keep their account, so one person can work in several workspaces. Throws InviteFailure
 * for every problem with the invite, and "already_member" for someone who is in the workspace already (the invite stays unused).
 */
export async function acceptInviteAsMember(user: { id: string; email: string }, token: string, now = new Date()) {
  if (!TOKEN_RE.test(token)) throw new InviteFailure("invalid");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invites).where(and(eq(invites.tokenHash, sha256(token)), pending(now)));
    if (!inv || inv.kind !== "join_team" || !inv.teamId || inv.email !== normalizeEmail(user.email)) throw new InviteFailure("invalid");
    const [t] = await tx.select({ suspendedAt: teams.suspendedAt }).from(teams).where(eq(teams.id, inv.teamId)).for("update");
    if (!t || t.suspendedAt) throw new InviteFailure("invalid");
    const [already] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.teamId, inv.teamId), eq(memberships.userId, user.id)));
    if (already) throw new InviteError("conflict", "You are already in this workspace");
    if ((await memberCount(tx, inv.teamId)) >= maxTeamMembers()) throw new InviteFailure("team_full");
    const claimed = await tx.update(invites).set({ usedAt: now, usedBy: user.id }).where(and(eq(invites.id, inv.id), pending(now))).returning({ id: invites.id });
    if (!claimed.length) throw new InviteFailure("invalid");
    await tx.insert(memberships).values({ userId: user.id, teamId: inv.teamId, role: inv.role, tags: inv.tags });
    await grantInviteProjects(tx, inv, user.id, inv.teamId);
    console.info(`[invite] accepted ${inv.id} kind=join_team by an existing account`);
    return { teamId: inv.teamId };
  });
}
