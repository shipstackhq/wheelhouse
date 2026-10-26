import { Inject, Injectable } from "@nestjs/common";
import { canManagePeople, isWorkspaceRole } from "../../../common/roles";
import { ServiceError } from "../../../common/service-error";
import { isUuid } from "../../../common/uuid";
import { Database } from "../../../platform/database/database";
import { isInstanceAdmin, maxWorkspaceMembers, workspaceCreateOpen } from "../auth-policy";
import { AdminError } from "../auth-errors";
import { AuthRepository } from "../auth.repository";
import { isUniqueViolation, issuerOf, parseTags, requireAdmin, requireManager } from "../auth.rules";
import { memberView, type WorkspaceMember } from "../auth.presenter";
import { InvitesService } from "../invites/invites.service";
import type { Human } from "../sessions.service";
import type { WorkspaceRole } from "../../../db/schema";
import { slugProblem } from "./workspace-slug";

/** An instance admin: who is asking, and which workspace they are working in. */
export type Admin = { userId: string; email: string; workspaceId: string };

export type WorkspaceSummary = {
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
  teams: number;
  lastActivity: Date | null;
  invitedBy: { name: string; email: string } | null;
  isYours: boolean;
};

export type WorkspaceDetail = WorkspaceSummary & {
  suspendedBy: { name: string; email: string } | null;
  memberList: { userId: string; name: string; email: string; role: WorkspaceRole; tags: string[]; joinedAt: Date }[];
  inviteList: { id: string; kind: "new_workspace" | "join_workspace"; email: string; role: string; status: "pending" | "used" | "revoked" | "expired"; expiresAt: Date; createdAt: Date }[];
  keys: { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }[];
};

const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);

/**
 * A workspace as its members see it (the members page, the removal and role changes of a person, the workspace's pending invites) and as
 * an instance admin sees the workspaces on this server (metadata only: names, emails, counts, dates; nothing a workspace wrote). Suspending
 * is reversible: it records who, when and why, signs the members out, and the checks in the sessions and invites services refuse the
 * workspace while the flag is set. Every statement is scoped by the signed-in person's own workspace id.
 */
@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuthRepository) private readonly repo: AuthRepository,
    @Inject(InvitesService) private readonly invites: InvitesService,
  ) {}

  /** Anyone signed in makes a team workspace and owns it; `slug` comes from the name unless typed (refused with a field error when bad or taken). */
  async createAs(h: Human, input: { name: string; slug?: string }) {
    if (!workspaceCreateOpen() && !isInstanceAdmin(h.user.email)) throw new ServiceError("forbidden", "Creating workspaces is turned off on this instance");
    const name = input.name.trim().slice(0, 100);
    if (!name) throw new ServiceError("invalid", "Enter a name", { fields: { name: "Enter a name" } });
    const slug = input.slug?.trim().toLowerCase() || undefined;
    const bad = (m: string) => new ServiceError("invalid", m, { fields: { slug: m } });
    if (slug) {
      const problem = slugProblem(slug);
      if (problem) throw bad(problem);
      if (await this.repo.slugTaken(slug)) throw bad("That address is taken");
    }
    try {
      return await this.db.transaction(async () => {
        const w = await this.repo.insertWorkspace(name, "team", slug);
        await this.repo.insertMembership({ userId: h.user.id, workspaceId: w.id, role: "owner" });
        return { id: w.id, slug: w.slug, name: w.name, kind: w.kind, role: "owner" as const };
      });
    } catch (e) {
      if (slug && isUniqueViolation(e)) throw bad("That address is taken");
      throw e;
    }
  }

  /** The workspace page: its members, the seats, and (for owners) the invites still waiting. */
  async workspaceOverview(h: Human) {
    const rows = await this.repo.membersOf(h.workspace.id);
    // A guest sees no directory of people: just themselves.
    const visible = h.membership.role === "guest" ? rows.filter(({ user }) => user.id === h.user.id) : rows;
    const pendingOwnerId = (await this.repo.workspaceById(h.workspace.id))?.pendingOwnerId;
    const pending = rows.find(({ user }) => user.id === pendingOwnerId)?.user;
    // Only the owner who offered it and the person offered it see a transfer.
    const transfer = pending && (h.membership.role === "owner" || pending.id === h.user.id) ? { userId: pending.id, name: pending.name } : null;
    const pendingInvites = canManagePeople(h.membership.role) ? (await this.invites.listInvites(issuerOf(h))).filter((i) => i.kind === "join_workspace") : [];
    return {
      workspace: { id: h.workspace.id, name: h.workspace.name, agentsEnabled: h.workspace.settings.agentsEnabled !== false },
      role: h.membership.role,
      members: visible.map(({ user: u, m }) => memberView(u, m)),
      transfer,
      seats: await this.invites.seatInfo(h.workspace.id),
      pendingInvites,
    };
  }

  /** Change a member's role and tags. Refuses to demote the only owner. A change of role is written to the access audit log. */
  async updateMember(workspaceId: string, actingUserId: string, input: { userId: string; role: WorkspaceRole; tags: string[] }) {
    if (!isUuid(input.userId)) return false;
    if (input.userId === actingUserId && input.role !== "owner") {
      if ((await this.repo.ownerCount(workspaceId)) <= 1) return false; // keep at least one owner
    }
    return this.db.transaction(async () => {
      const before = await this.repo.membershipRole(workspaceId, input.userId);
      const rows = await this.repo.updateMembership(workspaceId, input.userId, input.role, input.tags);
      if (rows.length && before && before.role !== input.role) {
        const actorName = await this.repo.userName(actingUserId);
        await this.repo.insertAudit({
          workspaceId,
          actorKind: "human",
          actorId: actingUserId,
          actorName: actorName ?? "Someone",
          action: "workspace.role_changed",
          targetType: "user",
          targetId: input.userId,
          before: { role: before.role },
          after: { role: input.role },
        });
      }
      return rows.length > 0;
    });
  }

  /**
   * Removes the person from the workspace and from every team of it. A team must keep one admin (ADR-23), so someone who is the only admin
   * of a team cannot be removed until another admin is named; the error says which teams.
   */
  async removeMember(workspaceId: string, actingUserId: string, userId: string) {
    if (userId === actingUserId || !isUuid(userId)) return false;
    return this.db.transaction(async () => {
      if (!(await this.repo.membershipExists(workspaceId, userId))) return false;
      const adminOf = await this.repo.teamsAdminOf(workspaceId, userId);
      if (adminOf.length) {
        const others = await this.repo.adminsOtherThan(adminOf.map((p) => p.id), userId);
        const covered = new Set(others.map((o) => o.id));
        const stranded = adminOf.filter((p) => !covered.has(p.id)).map((p) => p.key);
        if (stranded.length) {
          throw new ServiceError("conflict", `They are the only admin of ${stranded.join(", ")}. Name another team admin first.`, { teams: stranded });
        }
      }
      await this.repo.deleteTeamMembershipsOf(workspaceId, userId);
      await this.repo.deleteMembership(workspaceId, userId);
      const actorName = await this.repo.userName(actingUserId);
      await this.repo.insertAudit({
        workspaceId,
        actorKind: "human",
        actorId: actingUserId,
        actorName: actorName ?? "Someone",
        action: "workspace.member_removed",
        targetType: "user",
        targetId: userId,
      });
      return true;
    });
  }

  /** Owners and admins change workspace settings: `{ agentsEnabled }`. Answers the settings. */
  async updateSettingsAs(h: Human, input: { agentsEnabled?: boolean }) {
    requireManager(h.membership.role);
    return this.repo.mergeSettings(h.workspace.id, input);
  }

  /** Owners and admins change a member's role and tags; only an owner can make or unmake an owner. The last owner cannot be demoted. */
  async updateMemberAs(h: Human, input: { userId: string; role: unknown; tags: unknown }): Promise<WorkspaceMember> {
    requireManager(h.membership.role);
    const role = isWorkspaceRole(input.role) ? input.role : null;
    if (!role) throw new ServiceError("invalid", "Choose a role: owner, admin, member, viewer or guest", { fields: { role: "Choose a role" } });
    const current = (await this.workspaceOverview(h)).members.find((m) => m.userId === input.userId)?.role;
    if (h.membership.role !== "owner" && (role === "owner" || current === "owner")) throw new ServiceError("forbidden", "Only an owner can make or change an owner");
    const tags = parseTags(input.tags).slice(0, 20);
    const changed = await this.updateMember(h.workspace.id, h.user.id, { userId: input.userId, role, tags });
    if (!changed) {
      const existing = (await this.workspaceOverview(h)).members.some((m) => m.userId === input.userId);
      if (!existing) throw new ServiceError("not_found", "Member not found");
      throw new ServiceError("conflict", "A workspace needs at least one owner");
    }
    return (await this.workspaceOverview(h)).members.find((m) => m.userId === input.userId)!;
  }

  /** The owner offers ownership to another member who is not a guest; it moves only when they accept. Replaces an earlier offer. */
  async requestTransfer(h: Human, userId: string) {
    if (h.membership.role !== "owner") throw new ServiceError("forbidden", "Only an owner can transfer the workspace");
    const target = isUuid(userId) && userId !== h.user.id ? await this.repo.membershipRole(h.workspace.id, userId) : undefined;
    if (!target || target.role === "guest") throw new ServiceError("invalid", "Choose another member of this workspace, not a guest", { fields: { userId: "Choose a member" } });
    await this.repo.setPendingOwner(h.workspace.id, userId);
    return { ok: true as const };
  }

  /** The owner withdraws the offer. */
  async cancelTransfer(h: Human) {
    if (h.membership.role !== "owner") throw new ServiceError("forbidden", "Only an owner can transfer the workspace");
    await this.repo.setPendingOwner(h.workspace.id, null);
    return { ok: true as const };
  }

  /** The person offered ownership turns it down. */
  async declineTransfer(h: Human) {
    await this.db.transaction(async () => {
      await this.offeredTo(h);
      await this.repo.setPendingOwner(h.workspace.id, null);
    });
    return { ok: true as const };
  }

  /** The person offered ownership accepts: they become the owner, the current owners become admins. Audited. */
  async acceptTransfer(h: Human) {
    await this.db.transaction(async () => {
      await this.offeredTo(h);
      if ((await this.repo.membershipRole(h.workspace.id, h.user.id))?.role === "guest") throw new ServiceError("conflict", "A guest cannot own a workspace");
      await this.repo.moveOwnership(h.workspace.id, h.user.id);
      await this.repo.setPendingOwner(h.workspace.id, null);
      await this.repo.insertAudit({ workspaceId: h.workspace.id, actorKind: "human", actorId: h.user.id, actorName: h.user.name, action: "workspace.ownership_transferred", targetType: "user", targetId: h.user.id });
    });
    return { ok: true as const };
  }

  /** Locks the workspace and checks the offer is still to this person (not_found otherwise). */
  private async offeredTo(h: Human) {
    const w = await this.repo.lockWorkspace(h.workspace.id);
    if (w?.pendingOwnerId !== h.user.id) throw new ServiceError("not_found", "No ownership transfer is waiting for you");
  }

  /** Owners and admins remove a member (an admin cannot remove an owner). Nobody removes themselves here. */
  async removeMemberAs(h: Human, userId: string) {
    requireManager(h.membership.role);
    const target = (await this.workspaceOverview(h)).members.find((m) => m.userId === userId);
    if (target?.role === "owner" && h.membership.role !== "owner") throw new ServiceError("forbidden", "Only an owner can remove an owner");
    if (userId === h.user.id) throw new ServiceError("invalid", "You cannot remove yourself");
    if (!(await this.removeMember(h.workspace.id, h.user.id, userId))) throw new ServiceError("not_found", "Member not found");
    return { ok: true as const };
  }

  // ───────── instance admin ─────────

  /** Every workspace on this server, with its owners, counts, seats and last activity. */
  async adminListWorkspaces(admin: Admin, now = new Date()): Promise<WorkspaceSummary[]> {
    requireAdmin(admin.email);
    const [workspaceRows, memberRows, pendingRows, teamRows, eventRows, keyRows, founderRows] = await Promise.all([
      this.repo.allWorkspaces(),
      this.repo.allMemberships(),
      this.repo.pendingJoinCounts(now),
      this.repo.teamCounts(),
      this.repo.lastEventAts(),
      this.repo.lastKeyUses(),
      // who sent the new-workspace invite each founder used
      this.repo.founderInvites(),
    ]);

    const memberWorkspace = new Map<string, string>(); // user id -> workspace id, to find a founder's workspace
    const byWorkspace = new Map<string, typeof memberRows>();
    for (const m of memberRows) {
      byWorkspace.set(m.workspaceId, [...(byWorkspace.get(m.workspaceId) ?? []), m]);
    }
    const userWorkspace = await this.repo.allMembershipUserWorkspaces();
    for (const u of userWorkspace) memberWorkspace.set(u.userId, u.workspaceId);
    const invitedBy = new Map<string, { name: string; email: string }>();
    for (const f of founderRows) {
      const t = f.usedBy ? memberWorkspace.get(f.usedBy) : undefined;
      if (t) invitedBy.set(t, { name: f.name, email: f.email });
    }
    const pending = new Map(pendingRows.map((r) => [r.workspaceId, r.n]));
    const projCount = new Map(teamRows.map((r) => [r.workspaceId, r.n]));
    const lastEvent = new Map(eventRows.map((r) => [r.workspaceId, asDate(r.at)]));
    const lastKey = new Map(keyRows.map((r) => [r.workspaceId, asDate(r.at)]));
    const max = maxWorkspaceMembers();

    return workspaceRows.map((t) => {
      const ms = byWorkspace.get(t.id) ?? [];
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
        teams: projCount.get(t.id) ?? 0,
        lastActivity: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
        invitedBy: invitedBy.get(t.id) ?? null,
        isYours: t.id === admin.workspaceId,
      };
    });
  }

  async getWorkspaceDetail(admin: Admin, workspaceId: string, now = new Date()): Promise<WorkspaceDetail> {
    requireAdmin(admin.email);
    const summary = (await this.adminListWorkspaces(admin, now)).find((t) => t.id === workspaceId);
    if (!summary) throw new AdminError("not_found", "Workspace not found");
    const workspace = await this.repo.workspaceById(workspaceId);
    const by = workspace?.suspendedBy ? await this.repo.userContact(workspace.suspendedBy) : undefined;
    const memberRows = await this.repo.membersOf(workspaceId);
    const memberList = memberRows.map(({ user: u, m }) => ({ userId: u.id, name: u.name, email: u.email, role: m.role, tags: m.tags, joinedAt: m.createdAt }));
    const memberIds = memberList.map((m) => m.userId);
    const inviteRows = await this.repo.invitesTouching(workspaceId, memberIds);
    const inviteList = inviteRows.map((i) => ({
      id: i.id,
      kind: i.kind,
      email: i.email,
      role: i.role,
      status: (i.usedAt ? "used" : i.revokedAt ? "revoked" : i.expiresAt <= now ? "expired" : "pending") as "pending" | "used" | "revoked" | "expired",
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    }));
    const keys = (await this.repo.keysOf(workspaceId)).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt }));
    return { ...summary, suspendedBy: by ?? null, memberList, inviteList, keys };
  }

  /**
   * Cut a workspace off. Needs the workspace's exact name as confirmation, refuses the admin's own workspace (no self lockout), and signs
   * every member out in the same transaction.
   */
  async suspendWorkspace(admin: Admin, workspaceId: string, input: { reason?: string; confirmName: string }, now = new Date()) {
    requireAdmin(admin.email);
    if (workspaceId === admin.workspaceId) throw new AdminError("conflict", "You cannot suspend your own workspace");
    const result = await this.db.transaction(async () => {
      const t = await this.repo.lockWorkspace(workspaceId);
      if (!t) throw new AdminError("not_found", "Workspace not found");
      if (t.suspendedAt) throw new AdminError("conflict", "That workspace is already suspended");
      if (input.confirmName.trim() !== t.name) throw new AdminError("invalid", "Type the workspace name exactly to confirm");
      await this.repo.suspendWorkspaceRow(workspaceId, {
        suspendedAt: now,
        suspendedBy: admin.userId,
        suspendedReason: (input.reason ?? "").trim().slice(0, 500) || null,
      });
      const gone = await this.repo.deleteSessionsOfWorkspace(workspaceId);
      return { name: t.name, sessionsEnded: gone.length };
    });
    console.info(`[admin] workspace suspended ${workspaceId} by=${admin.userId} sessions_ended=${result.sessionsEnded}`);
    return result;
  }

  async restoreWorkspace(admin: Admin, workspaceId: string) {
    requireAdmin(admin.email);
    const rows = await this.repo.restoreWorkspaceRow(workspaceId);
    if (!rows.length) throw new AdminError("conflict", "That workspace is not suspended");
    console.info(`[admin] workspace restored ${workspaceId} by=${admin.userId}`);
  }
}
