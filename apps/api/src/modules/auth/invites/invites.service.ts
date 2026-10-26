import { Inject, Injectable } from "@nestjs/common";
import { sha256, randomToken } from "../../../common/crypto";
import { canManagePeople, isWorkspaceRole } from "../../../common/roles";
import { ServiceError } from "../../../common/service-error";
import { rateLimit } from "../../../common/rate-limit";
import type { TeamRole, WorkspaceRole } from "../../../db/schema";
import { Database } from "../../../platform/database/database";
import { TeamAccessService } from "../../teams/index";
import { InviteError, InviteFailure, INVITE_INVALID } from "../auth-errors";
import { inviteTtlHours, isInstanceAdmin, maxWorkspaceMembers, passwordProblem } from "../auth-policy";
import { AuthRepository, type InviteRow } from "../auth.repository";
import { emailOk, isUniqueViolation, issuerOf, normalizeEmail, parseGrants, parseTags, TOKEN_RE, tooMany, type Issuer } from "../auth.rules";
import { hashPassword } from "../passwords";
import { SessionsService, type Human } from "../sessions.service";
import { inviteLinkView } from "../auth.presenter";

export type { Issuer } from "../auth.rules";
export type NewInvite = { id: string; token: string; email: string; kind: "new_workspace" | "join_workspace"; expiresAt: Date };

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

/**
 * Invite-only signup (WH-49).
 *  - A link carries a 256-bit random token. Only its SHA-256 is stored.
 *  - An invite is bound to one email, one kind (new_workspace | join_workspace), one workspace and one role. The accept
 *    path takes none of those from the client.
 *  - Acceptance claims the invite with one guarded UPDATE inside the transaction that creates the
 *    account, so two simultaneous accepts cannot both win. A join invite also locks its workspace row to
 *    check the seat limit, so concurrent accepts cannot overshoot it.
 *  - Failures at acceptance all look the same to the caller (INVITE_INVALID); `reason` is for tests and logs.
 *
 * The `...As` methods take the request as the web app sends it and check it; the controllers answer with what they return.
 */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuthRepository) private readonly repo: AuthRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  /** Seats of a workspace: members plus pending join invites, against the limit. */
  async seatInfo(workspaceId: string, now = new Date()) {
    const members = await this.repo.memberCount(workspaceId);
    const pendingInvites = await this.repo.pendingJoinCount(workspaceId, now);
    const max = maxWorkspaceMembers();
    return { members, pending: pendingInvites, used: members + pendingInvites, max, full: members + pendingInvites >= max };
  }

  /** Create an invite. Returns the plain token once; it cannot be recovered later. */
  async createInvite(
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
          p = await this.access.require(who, g.team, "admin");
        } catch {
          throw new InviteError("forbidden", `You can only add people to teams you administer (${g.team})`);
        }
        if (!grants.some((x) => x.teamId === p.id)) grants.push({ teamId: p.id, role: g.role });
      }
    }
    const workspaceName = input.kind === "new_workspace" ? (input.workspaceName ?? "").trim().slice(0, 100) || null : null;
    const role = input.kind === "join_workspace" ? wanted : "member";
    const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 20);

    // Only an instance admin may learn that an address already has an account. A workspace owner must not be able to
    // probe which emails are registered on the server (possibly in other workspaces), so for them the invite is created
    // either way; if the address already has an account, accepting the link simply fails like any invalid link.
    if (input.kind === "new_workspace") {
      if (await this.repo.userByEmail(email)) throw new InviteError("conflict", "An account with that email already exists");
    }

    const token = randomToken(32);
    const expiresAt = new Date(now.getTime() + inviteTtlHours() * 3_600_000);
    const row = await this.db.transaction(async () => {
      if (input.kind === "join_workspace") {
        // Lock the workspace so two owners (or two tabs) cannot both take the last seat.
        const t = await this.repo.lockWorkspace(issuer.workspaceId);
        if (t?.suspendedAt) throw new InviteError("forbidden", "This workspace has been suspended. Contact the administrator.");
        const used = (await this.repo.memberCount(issuer.workspaceId)) + (await this.repo.pendingJoinCount(issuer.workspaceId, now));
        const max = maxWorkspaceMembers();
        if (used >= max) {
          throw new InviteError(
            "workspace_full",
            `Your workspace is full (${used} of ${max} seats used, counting pending invites). Revoke an invite or remove a member.`,
          );
        }
      }
      const dup = await this.repo.duplicatePendingInvite(input.kind, email, input.kind === "join_workspace" ? issuer.workspaceId : null, now);
      if (dup) throw new InviteError("conflict", "That email already has a pending invite. Revoke it first to send a new one.");

      const r = await this.repo.insertInvite({
        kind: input.kind,
        email,
        workspaceId: input.kind === "join_workspace" ? issuer.workspaceId : null,
        workspaceName,
        role,
        tags,
        tokenHash: sha256(token),
        createdBy: issuer.userId,
        expiresAt,
      });
      if (grants.length && input.kind === "join_workspace") {
        await this.repo.insertInviteTeams(grants.map((g) => ({ inviteId: r.id, teamId: g.teamId, workspaceId: issuer.workspaceId, role: g.role })));
      }
      return r;
    });
    console.info(`[invite] created ${row.id} kind=${input.kind} by=${issuer.userId}`);
    return { id: row.id, token, email, kind: input.kind, expiresAt };
  }

  /** Pending invites the issuer may see: their workspace's join invites (owners) and new-workspace invites (admins). */
  async listInvites(issuer: Issuer, now = new Date()): Promise<PendingInvite[]> {
    const scope = { joinWorkspaceId: canManagePeople(issuer.role) ? issuer.workspaceId : undefined, newWorkspaces: isInstanceAdmin(issuer.email) };
    if (!scope.joinWorkspaceId && !scope.newWorkspaces) return [];
    const rows = await this.repo.pendingInvitesIn(scope, now);
    const granted = rows.length ? await this.repo.grantedTeams(rows.map((r) => r.id)) : [];
    return rows.map((r) => ({ ...r, teams: granted.filter((g) => g.inviteId === r.id).map(({ key, name, role }) => ({ key, name, role })) }));
  }

  async revokeInvite(issuer: Issuer, id: string, now = new Date()) {
    const scope = { joinWorkspaceId: canManagePeople(issuer.role) ? issuer.workspaceId : undefined, newWorkspaces: isInstanceAdmin(issuer.email) };
    if (!scope.joinWorkspaceId && !scope.newWorkspaces) throw new InviteError("forbidden", "Only workspace owners and admins can revoke invites");
    const rows = await this.repo.revokeInviteRow(id, now, scope);
    if (!rows.length) throw new InviteError("not_found", "That invite was not found or has already been used");
    console.info(`[invite] revoked ${id} by=${issuer.userId}`);
  }

  /** What the invite page shows before the person picks a password. null for every kind of bad link. */
  async peekInvite(token: string, now = new Date()) {
    if (!TOKEN_RE.test(token)) return null;
    const row = await this.repo.pendingInviteByTokenHash(sha256(token), now);
    if (!row) return null;
    if (await this.repo.userByEmail(row.email)) return null;
    let workspaceName = row.workspaceName;
    if (row.kind === "join_workspace" && row.workspaceId) {
      const t = await this.repo.workspaceById(row.workspaceId);
      if (!t || t.suspendedAt) return null;
      workspaceName = t.name;
    }
    return { email: row.email, kind: row.kind, workspaceName };
  }

  /**
   * Put the person into the teams the inviter chose, as long as each still belongs to the workspace. One audit line each, in the
   * inviter's name. Shared by a new account accepting and an existing account accepting.
   */
  private async grantInviteTeams(inv: InviteRow, userId: string, workspaceId: string) {
    const grants = await this.repo.inviteGrants(inv.id);
    if (!grants.length) return;
    const issuerName = inv.createdBy ? await this.repo.userName(inv.createdBy) : undefined;
    for (const g of grants) {
      const p = await this.repo.teamInWorkspace(g.teamId, workspaceId);
      if (!p) continue;
      await this.repo.addTeamMember({ teamId: p.id, userId, workspaceId, role: g.role, addedBy: inv.createdBy });
      await this.access.audit({ kind: "human", id: inv.createdBy ?? userId, name: issuerName ?? "An invite", workspaceId }, { action: "team.member_added", targetType: "user", targetId: userId, teamId: p.id, after: { role: g.role, via: "invite" } });
    }
  }

  /**
   * Consume an invite and create the account. Returns the new user id; the caller starts the session.
   * Throws InviteError for a weak password or name (nothing about the token is revealed) and InviteFailure for every problem with the
   * invite itself.
   */
  async acceptInvite(input: { token: string; name: string; password: string }, now = new Date()) {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new InviteError("invalid", "Enter your name");
    const weak = passwordProblem(input.password);
    if (weak) throw new InviteError("weak_password", weak);
    if (!TOKEN_RE.test(input.token)) throw new InviteFailure("invalid");

    const tokenHash = sha256(input.token);
    const passwordHash = await hashPassword(input.password); // slow: done before the transaction holds any lock
    try {
      return await this.db.transaction(async () => {
        const inv = await this.repo.pendingInviteByTokenHash(tokenHash, now);
        if (!inv) throw new InviteFailure("invalid");

        if (inv.kind === "join_workspace") {
          if (!inv.workspaceId) throw new InviteFailure("invalid");
          const t = await this.repo.lockWorkspace(inv.workspaceId);
          if (!t || t.suspendedAt) throw new InviteFailure("invalid"); // a suspended workspace's invites are inert
          if ((await this.repo.memberCount(inv.workspaceId)) >= maxWorkspaceMembers()) throw new InviteFailure("workspace_full");
        }

        // The claim: succeeds for exactly one caller, whatever the concurrency.
        const claimed = await this.repo.claimInvite(inv.id, now);
        if (!claimed.length) throw new InviteFailure("invalid");

        if (await this.repo.userByEmail(inv.email)) throw new InviteFailure("account_exists");
        const u = await this.repo.insertUser({ email: inv.email, name, passwordHash });

        let workspaceId = inv.workspaceId;
        if (inv.kind === "new_workspace") {
          const workspaceName = inv.workspaceName || `${name}'s workspace`;
          const t = await this.repo.insertWorkspace(workspaceName);
          workspaceId = t.id;
          await this.repo.insertMembership({ userId: u.id, workspaceId, role: "owner" });
        } else {
          await this.repo.insertMembership({ userId: u.id, workspaceId: workspaceId!, role: inv.role, tags: inv.tags });
          await this.repo.markTeam(workspaceId!);
        }
        if (inv.kind === "join_workspace") await this.grantInviteTeams(inv, u.id, workspaceId!);
        await this.repo.setInviteUsedBy(inv.id, u.id);
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
   * What a signed-in person is being invited to, when the invite was sent to their own email and they already have an account (they
   * will join another workspace with it). Anything else, including an invite for someone else's address, is null.
   */
  async peekInviteAsMember(user: { email: string }, token: string, now = new Date()) {
    if (!TOKEN_RE.test(token)) return null;
    const row = await this.repo.pendingInviteByTokenHash(sha256(token), now);
    if (!row || row.kind !== "join_workspace" || !row.workspaceId || row.email !== normalizeEmail(user.email)) return null;
    const t = await this.repo.workspaceById(row.workspaceId);
    if (!t || t.suspendedAt) return null;
    const granted = await this.repo.grantedTeams([row.id]);
    return { email: row.email, workspaceName: t.name, role: row.role, teams: granted.map(({ key, name, role }) => ({ key, name, role })) };
  }

  /**
   * A signed-in person with an account accepts a join invite sent to their own email: they become a member of that workspace (and of the
   * teams chosen) and keep their account. Throws InviteFailure for every problem with the invite, and InviteError "conflict" for someone
   * who is in the workspace already (the invite stays unused).
   */
  async acceptInviteAsMember(user: { id: string; email: string }, token: string, now = new Date()) {
    if (!TOKEN_RE.test(token)) throw new InviteFailure("invalid");
    return this.db.transaction(async () => {
      const inv = await this.repo.pendingInviteByTokenHash(sha256(token), now);
      if (!inv || inv.kind !== "join_workspace" || !inv.workspaceId || inv.email !== normalizeEmail(user.email)) throw new InviteFailure("invalid");
      const t = await this.repo.lockWorkspace(inv.workspaceId);
      if (!t || t.suspendedAt) throw new InviteFailure("invalid");
      if (await this.repo.membershipExists(inv.workspaceId, user.id)) throw new InviteError("conflict", "You are already in this workspace");
      if ((await this.repo.memberCount(inv.workspaceId)) >= maxWorkspaceMembers()) throw new InviteFailure("workspace_full");
      const claimed = await this.repo.claimInvite(inv.id, now, user.id);
      if (!claimed.length) throw new InviteFailure("invalid");
      await this.repo.insertMembership({ userId: user.id, workspaceId: inv.workspaceId, role: inv.role, tags: inv.tags });
      await this.repo.markTeam(inv.workspaceId);
      await this.grantInviteTeams(inv, user.id, inv.workspaceId);
      console.info(`[invite] accepted ${inv.id} kind=join_workspace by an existing account`);
      return { workspaceId: inv.workspaceId };
    });
  }

  // ───────── the web app's invite pages (WH-95) ─────────

  /** Pending invites the person may see of one kind. */
  async pendingInvites(h: Human, kind: "join_workspace" | "new_workspace"): Promise<PendingInvite[]> {
    return (await this.listInvites(issuerOf(h))).filter((i) => i.kind === kind);
  }

  /**
   * Create an invite link. The token goes in the URL fragment so it never reaches server logs, proxies or Referer headers, and it is
   * returned only here. Owners and admins only (checked in createInvite); 20 an hour per person.
   */
  async createInviteAs(
    h: Human,
    input: { kind?: unknown; email: string; role?: unknown; tags?: unknown; workspace?: string; teams?: unknown },
    origin: string,
  ) {
    const hit = rateLimit(`invite-create:${h.user.id}`, 20, 60 * 60_000);
    if (!hit.ok) throw tooMany(hit.retryAfter);
    const kind = input.kind === "new_workspace" ? "new_workspace" : "join_workspace";
    const inv = await this.createInvite(issuerOf(h), {
      kind,
      email: String(input.email ?? ""),
      role: isWorkspaceRole(input.role) ? input.role : "member",
      tags: parseTags(input.tags),
      workspaceName: String(input.workspace ?? ""),
      teams: parseGrants(input.teams),
    });
    return inviteLinkView(inv, origin);
  }

  async revokeInviteAs(h: Human, id: string) {
    await this.revokeInvite(issuerOf(h), id);
    return { ok: true as const };
  }

  /** What the invite page shows before the person picks a password. The same answer for every bad link; 30 tries per 15 minutes per address. */
  async peekInviteAs(token: string, ip: string) {
    const hit = rateLimit(`invite-ip:${ip}`, 30, 15 * 60_000);
    if (!hit.ok) throw tooMany(hit.retryAfter);
    const invite = await this.peekInvite(String(token ?? ""));
    if (!invite) throw new ServiceError("invalid", INVITE_INVALID);
    return invite;
  }

  /** Accept an invite: creates the account (and a workspace for a new-workspace invite). The caller then starts the session. */
  async acceptInviteAs(input: { token: string; name: string; password: string; confirm: string }, ip: string) {
    const hit = rateLimit(`invite-ip:${ip}`, 30, 15 * 60_000);
    if (!hit.ok) throw tooMany(hit.retryAfter);
    if (input.password !== input.confirm) throw new ServiceError("invalid", "The two passwords do not match", { fields: { confirm: "The two passwords do not match" } });
    return this.acceptInvite({ token: String(input.token ?? ""), name: input.name, password: input.password });
  }

  /**
   * What a signed-in person is invited to when the invite was sent to their own address and they already have an account. The same answer
   * for every bad link (and for someone else's invite); 30 tries per 15 minutes per person.
   */
  async peekInviteAsMemberAs(h: Human, token: string) {
    const hit = rateLimit(`invite-user:${h.user.id}`, 30, 15 * 60_000);
    if (!hit.ok) throw tooMany(hit.retryAfter);
    const invite = await this.peekInviteAsMember(h.user, String(token ?? ""));
    if (!invite) throw new ServiceError("invalid", INVITE_INVALID);
    return invite;
  }

  /** An existing account joins another workspace through an invite sent to its own address, then this session moves into it. */
  async acceptInviteAsMemberAs(h: Human, token: string, sessionToken: string) {
    const hit = rateLimit(`invite-user:${h.user.id}`, 30, 15 * 60_000);
    if (!hit.ok) throw tooMany(hit.retryAfter);
    const { workspaceId } = await this.acceptInviteAsMember(h.user, String(token ?? ""));
    const workspace = await this.sessions.switchWorkspace(sessionToken, h.user.id, workspaceId);
    return { workspace: workspace ?? { id: workspaceId, name: "" } };
  }
}
