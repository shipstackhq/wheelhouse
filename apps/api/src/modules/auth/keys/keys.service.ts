import { Inject, Injectable } from "@nestjs/common";
import { sha256, randomToken } from "../../../common/crypto";
import type { Actor } from "../../../common/actor";
import { rateLimit } from "../../../common/rate-limit";
import { roleAllows } from "../../../common/roles";
import { ServiceError } from "../../../common/service-error";
import { KEY_SCOPES } from "@wheelhouse/shared/key-scopes";
import { onboarding } from "@wheelhouse/shared/onboarding";
import { Database } from "../../../platform/database/database";
import { TeamAccessService, TeamsService } from "../../teams/index";
import { AuthError, RateLimitError, SuspendedError } from "../auth-errors";
import { AuthRepository } from "../auth.repository";
import { tooMany } from "../auth.rules";
import { keyView, type KeyView } from "../auth.presenter";
import type { Human } from "../sessions.service";

// Failed key attempts per client address, and steady-state calls per valid key.
const BAD_KEY_LIMIT = 30;
const BAD_KEY_WINDOW_MS = 60_000;
const KEY_CALL_LIMIT = 600;
const KEY_CALL_WINDOW_MS = 60_000;

/**
 * API keys (agents): the lookup behind a bearer token, the API keys page, creating, scoping, changing and revoking keys. A key reaches a
 * team only through its api_key_teams rows (WH-120); the scope is always chosen from teams the signed-in person can edit.
 */
@Injectable()
export class KeysService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuthRepository) private readonly repo: AuthRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(TeamsService) private readonly teams: TeamsService,
  ) {}

  /** The agent behind an API key. `ip` only feeds the bad-key rate limit. */
  async actorForKey(key: string, ip: string): Promise<Actor> {
    const row = await this.repo.activeKeyByHash(sha256(key));
    if (!row) {
      const r = rateLimit(`badkey:${ip}`, BAD_KEY_LIMIT, BAD_KEY_WINDOW_MS);
      if (!r.ok) throw new RateLimitError(r.retryAfter);
      throw new AuthError("Invalid or revoked API key");
    }
    if (row.suspendedAt) throw new SuspendedError();
    const used = rateLimit(`key:${row.key.id}`, KEY_CALL_LIMIT, KEY_CALL_WINDOW_MS);
    if (!used.ok) throw new RateLimitError(used.retryAfter);
    await this.repo.touchKey(row.key.id, new Date());
    return { kind: "agent", id: row.key.id, name: row.key.name, workspaceId: row.key.workspaceId, scopes: row.key.capabilities };
  }

  /** The teams of each key, by key id. The API keys page shows all of them: a workspace member sees which teams an agent reaches, not what is in them. */
  private async teamsOfKeys(keyIds: string[]): Promise<Map<string, KeyView["teams"]>> {
    const out = new Map<string, KeyView["teams"]>(keyIds.map((id) => [id, []]));
    if (!keyIds.length) return out;
    const rows = await this.repo.keyTeams(keyIds);
    for (const r of rows) out.get(r.keyId)!.push({ key: r.key, name: r.name });
    return out;
  }

  /** Resolve team keys the person may give an agent: teams they can edit (nobody is pulled in), each named once. */
  private async scopeTeams(h: Human, keys: unknown): Promise<{ id: string; key: string }[]> {
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) throw new ServiceError("invalid", "teams must be a list of team keys", { fields: { teams: "a list of team keys" } });
    if (!keys.length) throw new ServiceError("invalid", "Choose at least one team: a key with no team reaches nothing", { fields: { teams: "Choose at least one team" } });
    const out: { id: string; key: string }[] = [];
    for (const k of keys as string[]) {
      const t = await this.access.require(h.actor, k, "edit");
      if (!out.some((x) => x.id === t.id)) out.push({ id: t.id, key: t.key });
    }
    return out;
  }

  private async editableTeams(h: Human): Promise<{ id: string; key: string }[]> {
    const roles = await this.access.roleMap(h.actor);
    const mine = [...roles].filter(([, role]) => roleAllows(role, "edit")).map(([id]) => id);
    return mine.length ? this.repo.teamsByIds(mine) : [];
  }

  /** The workspace's keys, newest first. Never the key itself: only its prefix is stored in the clear. */
  async listKeys(h: Human): Promise<KeyView[]> {
    const rows = await this.repo.keysOf(h.workspace.id);
    const teams = await this.teamsOfKeys(rows.map((r) => r.id));
    return rows.map((r) => keyView(r, teams.get(r.id)));
  }

  /** The API keys page: the keys and the commands to paste. With one team its real key goes in the commands, with several a KEY placeholder. */
  async keysPage(h: Human, origin: string) {
    const workspaceTeams = (await this.teams.list(h.actor)).map((p) => ({ key: p.key }));
    return { keys: await this.listKeys(h), setup: onboarding({ origin, teamKey: workspaceTeams.length === 1 ? workspaceTeams[0].key : null }) };
  }

  /**
   * Create a key. The secret is returned here and nowhere else; only its hash is stored. 10 an hour per person. `teams` are the keys
   * of the teams it can open (WH-120): teams the person edits, at least one; left out, every team they edit.
   */
  async createKeyAs(h: Human, name: string, teamKeys?: unknown) {
    const hit = rateLimit(`create-key:${h.user.id}`, 10, 60 * 60_000);
    if (!hit.ok) throw tooMany(hit.retryAfter);
    const label = name.trim().slice(0, 100) || "Claude agent";
    const secret = `wh_${randomToken(24)}`;
    const scope = teamKeys === undefined ? await this.editableTeams(h) : await this.scopeTeams(h, teamKeys);
    const row = await this.db.transaction(async () => {
      const k = await this.repo.insertKey({ workspaceId: h.workspace.id, name: label, prefix: secret.slice(0, 10), keyHash: sha256(secret), createdBy: h.user.id });
      if (scope.length) await this.repo.insertKeyTeams(scope.map((t) => ({ apiKeyId: k.id, teamId: t.id, workspaceId: h.workspace.id })));
      return k;
    });
    return { key: keyView(row, (await this.teamsOfKeys([row.id])).get(row.id)), secret };
  }

  /** Change the teams a key can open. Any team the person edits can be added; one they are not on cannot be taken away by them either, it stays as it is. */
  async setKeyTeamsAs(h: Human, id: string, teamKeys: unknown): Promise<KeyView> {
    const key = await this.repo.keyIn(id, h.workspace.id);
    if (!key) throw new ServiceError("not_found", "API key not found");
    const want = await this.scopeTeams(h, teamKeys);
    await this.db.transaction(async () => {
      // Teams the person cannot edit stay in the key's scope whatever the list says: they are not theirs to give or take.
      const roles = await this.access.roleMap(h.actor);
      const mine = new Set([...roles].filter(([, role]) => roleAllows(role, "edit")).map(([tid]) => tid));
      const have = await this.repo.keyTeamIds(id);
      const keep = have.filter((t) => !mine.has(t));
      const final = [...new Set([...keep, ...want.map((t) => t.id)])];
      const drop = have.filter((t) => !final.includes(t));
      if (drop.length) await this.repo.deleteKeyTeams(id, drop);
      const add = final.filter((t) => !have.includes(t));
      if (add.length) await this.repo.insertKeyTeams(add.map((t) => ({ apiKeyId: id, teamId: t, workspaceId: h.workspace.id })));
    });
    return keyView(key, (await this.teamsOfKeys([id])).get(id));
  }

  async revokeKeyAs(h: Human, id: string) {
    if (!(await this.revokeApiKey(h.workspace.id, id))) throw new ServiceError("not_found", "API key not found");
    return { ok: true as const };
  }

  /** Revokes one of the workspace's keys. Returns whether a row changed. */
  async revokeApiKey(workspaceId: string, keyId: string) {
    const rows = await this.repo.revokeKey(workspaceId, keyId);
    return rows.length > 0;
  }

  /** Set the scopes (KEY_SCOPES) of one of the workspace's own keys. */
  async setKeyScopesAs(h: Human, id: string, scopes: unknown): Promise<KeyView> {
    const key = await this.repo.keyIn(id, h.workspace.id);
    if (!key) throw new ServiceError("not_found", "API key not found");
    if (!Array.isArray(scopes) || scopes.some((s) => !(KEY_SCOPES as readonly unknown[]).includes(s))) throw new ServiceError("invalid", `scopes must be a list of: ${KEY_SCOPES.join(", ")}`, { fields: { scopes: KEY_SCOPES.join(", ") } });
    const row = await this.repo.setKeyCapabilities(id, h.workspace.id, [...new Set(scopes as string[])]);
    return keyView(row, (await this.teamsOfKeys([id])).get(id));
  }

  /**
   * Give a key every team its workspace has right now: what migration 0026 did to the keys that existed (WH-120). Later teams are not
   * added; a key that creates a team gets that one, and a person narrows or widens a key from the API keys page.
   */
  scopeKeyToAllTeams(keyId: string, workspaceId: string) {
    return this.repo.scopeKeyToAllTeams(keyId, workspaceId);
  }
}
