import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { isInstanceAdmin, maxTeamMembers } from "./auth-policy";

/**
 * Instance-admin view of the teams on this server, and the switch that cuts a whole team off (WH-52).
 *
 * Metadata only: names, emails, counts, dates. Nothing a team wrote (tickets, comments, the map) is read here.
 * Suspending is reversible: it records who/when/why on the team, signs its members out, and the checks in
 * auth.ts and invites.ts refuse the team while the flag is set. Restoring clears the flag.
 */

const { teams, memberships, users, invites, projects, events, apiKeys, sessions } = schema;

export type Admin = { userId: string; email: string; teamId: string };

export class AdminError extends Error {
  constructor(public code: "forbidden" | "not_found" | "invalid" | "conflict", message: string) {
    super(message);
  }
}

function requireAdmin(a: Admin) {
  if (!isInstanceAdmin(a.email)) throw new AdminError("forbidden", "Only instance admins can do that");
}

const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);

export type TeamSummary = {
  id: string;
  name: string;
  createdAt: Date;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  owners: { name: string; email: string }[];
  members: number;
  pendingInvites: number;
  seatsUsed: number;
  maxSeats: number;
  projects: number;
  lastActivity: Date | null;
  invitedBy: { name: string; email: string } | null;
  isYours: boolean;
};

export async function listTeams(admin: Admin, now = new Date()): Promise<TeamSummary[]> {
  requireAdmin(admin);
  const db = await getDb();
  const [teamRows, memberRows, pendingRows, projectRows, eventRows, keyRows, founderRows] = await Promise.all([
    db.select().from(teams).orderBy(teams.createdAt),
    db
      .select({ teamId: memberships.teamId, role: memberships.role, name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId)),
    db
      .select({ teamId: invites.teamId, n: sql<number>`count(*)::int` })
      .from(invites)
      .where(and(eq(invites.kind, "join_team"), isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now)))
      .groupBy(invites.teamId),
    db.select({ teamId: projects.teamId, n: sql<number>`count(*)::int` }).from(projects).groupBy(projects.teamId),
    db.select({ teamId: events.teamId, at: sql<string | null>`max(${events.createdAt})` }).from(events).groupBy(events.teamId),
    db.select({ teamId: apiKeys.teamId, at: sql<string | null>`max(${apiKeys.lastUsedAt})` }).from(apiKeys).groupBy(apiKeys.teamId),
    // who sent the new-team invite each founder used
    db
      .select({ usedBy: invites.usedBy, name: users.name, email: users.email })
      .from(invites)
      .innerJoin(users, eq(users.id, invites.createdBy))
      .where(and(eq(invites.kind, "new_team"), isNotNull(invites.usedBy))),
  ]);

  const memberTeam = new Map<string, string>(); // user id -> team id, to find a founder's team
  const byTeam = new Map<string, typeof memberRows>();
  for (const m of memberRows) {
    byTeam.set(m.teamId, [...(byTeam.get(m.teamId) ?? []), m]);
  }
  const userTeam = await db.select({ userId: memberships.userId, teamId: memberships.teamId }).from(memberships);
  for (const u of userTeam) memberTeam.set(u.userId, u.teamId);
  const invitedBy = new Map<string, { name: string; email: string }>();
  for (const f of founderRows) {
    const t = f.usedBy ? memberTeam.get(f.usedBy) : undefined;
    if (t) invitedBy.set(t, { name: f.name, email: f.email });
  }
  const pending = new Map(pendingRows.map((r) => [r.teamId, r.n]));
  const projCount = new Map(projectRows.map((r) => [r.teamId, r.n]));
  const lastEvent = new Map(eventRows.map((r) => [r.teamId, asDate(r.at)]));
  const lastKey = new Map(keyRows.map((r) => [r.teamId, asDate(r.at)]));
  const max = maxTeamMembers();

  return teamRows.map((t) => {
    const ms = byTeam.get(t.id) ?? [];
    const p = pending.get(t.id) ?? 0;
    const times = [lastEvent.get(t.id), lastKey.get(t.id)].filter((d): d is Date => !!d);
    return {
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      suspendedAt: t.suspendedAt,
      suspendedReason: t.suspendedReason,
      owners: ms.filter((m) => m.role === "owner").map((m) => ({ name: m.name, email: m.email })),
      members: ms.length,
      pendingInvites: p,
      seatsUsed: ms.length + p,
      maxSeats: max,
      projects: projCount.get(t.id) ?? 0,
      lastActivity: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
      invitedBy: invitedBy.get(t.id) ?? null,
      isYours: t.id === admin.teamId,
    };
  });
}

export type TeamDetail = TeamSummary & {
  suspendedBy: { name: string; email: string } | null;
  memberList: { userId: string; name: string; email: string; role: "owner" | "member"; tags: string[]; joinedAt: Date }[];
  inviteList: { id: string; kind: "new_team" | "join_team"; email: string; role: string; status: "pending" | "used" | "revoked" | "expired"; expiresAt: Date; createdAt: Date }[];
  keys: { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }[];
};

export async function getTeamDetail(admin: Admin, teamId: string, now = new Date()): Promise<TeamDetail> {
  requireAdmin(admin);
  const summary = (await listTeams(admin, now)).find((t) => t.id === teamId);
  if (!summary) throw new AdminError("not_found", "Team not found");
  const db = await getDb();
  const [team] = await db.select({ suspendedBy: teams.suspendedBy }).from(teams).where(eq(teams.id, teamId));
  const [by] = team?.suspendedBy
    ? await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, team.suspendedBy))
    : [];
  const memberList = await db
    .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, tags: memberships.tags, joinedAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.teamId, teamId))
    .orderBy(memberships.createdAt);
  const memberIds = memberList.map((m) => m.userId);
  const inviteRows = await db
    .select()
    .from(invites)
    .where(memberIds.length ? or(eq(invites.teamId, teamId), inArray(invites.usedBy, memberIds)) : eq(invites.teamId, teamId))
    .orderBy(desc(invites.createdAt));
  const inviteList = inviteRows.map((i) => ({
    id: i.id,
    kind: i.kind,
    email: i.email,
    role: i.role,
    status: (i.usedAt ? "used" : i.revokedAt ? "revoked" : i.expiresAt <= now ? "expired" : "pending") as "pending" | "used" | "revoked" | "expired",
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
  }));
  const keys = await db
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.teamId, teamId))
    .orderBy(desc(apiKeys.createdAt));
  return { ...summary, suspendedBy: by ?? null, memberList, inviteList, keys };
}

/**
 * Cut a team off. Needs the team's exact name as confirmation, refuses the admin's own team (no self lockout),
 * and signs every member out in the same transaction.
 */
export async function suspendTeam(admin: Admin, teamId: string, input: { reason?: string; confirmName: string }, now = new Date()) {
  requireAdmin(admin);
  if (teamId === admin.teamId) throw new AdminError("conflict", "You cannot suspend your own team");
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(teams).where(eq(teams.id, teamId)).for("update");
    if (!t) throw new AdminError("not_found", "Team not found");
    if (t.suspendedAt) throw new AdminError("conflict", "That team is already suspended");
    if (input.confirmName.trim() !== t.name) throw new AdminError("invalid", "Type the team name exactly to confirm");
    await tx
      .update(teams)
      .set({ suspendedAt: now, suspendedBy: admin.userId, suspendedReason: (input.reason ?? "").trim().slice(0, 500) || null })
      .where(eq(teams.id, teamId));
    const members = tx.select({ id: memberships.userId }).from(memberships).where(eq(memberships.teamId, teamId));
    const gone = await tx.delete(sessions).where(inArray(sessions.userId, members)).returning({ id: sessions.id });
    return { name: t.name, sessionsEnded: gone.length };
  });
  console.info(`[admin] team suspended ${teamId} by=${admin.userId} sessions_ended=${result.sessionsEnded}`);
  return result;
}

export async function restoreTeam(admin: Admin, teamId: string) {
  requireAdmin(admin);
  const db = await getDb();
  const rows = await db
    .update(teams)
    .set({ suspendedAt: null, suspendedBy: null, suspendedReason: null })
    .where(and(eq(teams.id, teamId), isNotNull(teams.suspendedAt)))
    .returning({ id: teams.id });
  if (!rows.length) throw new AdminError("conflict", "That team is not suspended");
  console.info(`[admin] team restored ${teamId} by=${admin.userId}`);
}
