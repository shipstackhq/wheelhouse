import { uuid, text, timestamp, integer, jsonb, primaryKey, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { table, createdAt } from "./common";
import { teamScope } from "./team-scope";
import { DEFAULT_KEY_SCOPES } from "@wheelhouse/shared/key-scopes";
import { TEAM_ROLES } from "./teams";

/**
 * Workspace roles (ADR-23). A role decides what a person may do around teams (create them, manage people, pay); it never
 * opens a team by itself: that takes a row in `team_members`.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer", "guest"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const users = table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  // Object-storage key of the profile picture (lib/storage.ts). Null: initials.
  avatarKey: text("avatar_key"),
  createdAt: createdAt(),
}, (t) => [
  // `email` is unique as written; this makes it unique however it is cased, so the code lower-casing it is not what holds it.
  uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
]);

export const sessions = table("sessions", {
  id: text("id").primaryKey(), // sha256 of the cookie token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // The workspace this session is working in, for a person who belongs to several (ADR-23). Null: their first one.
  activeWorkspaceId: uuid("active_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const workspaces = table("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // The workspace's address (`/w/<slug>` later). Created from the name; the default only keeps rows that skip it unique.
  slug: text("slug").notNull().unique().default(sql`replace(gen_random_uuid()::text, '-', '')`),
  // A person's own workspace (made at sign-up) or a team's. Inviting someone into a personal one makes it a team.
  kind: text("kind", { enum: ["personal", "team"] }).notNull().default("team"),
  // Ownership handed over but not yet accepted: the person who has to accept. At most one per workspace; null: none.
  pendingOwnerId: uuid("pending_owner_id").references(() => users.id, { onDelete: "set null" }),
  // Seats, owner included. Null: the instance default (MAX_WORKSPACE_MEMBERS).
  seatLimit: integer("seat_limit"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  // Object-storage key of the workspace's image (lib/storage.ts). Null: its initial.
  imageKey: text("image_key"),
  createdAt: createdAt(),
  // Instance-admin suspension (WH-52): a suspended workspace's members cannot sign in and its API keys are refused.
  // Reversible: nothing is deleted, restoring clears these three columns.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedBy: uuid("suspended_by").references(() => users.id, { onDelete: "set null" }),
  suspendedReason: text("suspended_reason"),
});

export const memberships = table(
  "memberships",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull().default("member"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

// Invite-only signup (WH-49). Only the SHA-256 of the token is stored; the plain token is shown once.
// kind new_workspace: the invitee gets a fresh workspace and owns it. kind join_workspace: the invitee joins workspace_id.
export const invites = table(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["new_workspace", "join_workspace"] }).notNull(),
    email: text("email").notNull(), // lower-cased; the account is created with exactly this address
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }), // join_workspace only
    workspaceName: text("workspace_name"), // new_workspace only (optional)
    role: text("role", { enum: WORKSPACE_ROLES }).notNull().default("member"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("invites_workspace_idx").on(t.workspaceId, t.usedAt), unique("invites_id_workspace_id_unique").on(t.id, t.workspaceId)],
);

/**
 * join_workspace invites only: the teams the person is put into when they accept, each with a team role (ADR-23). One row per
 * team; the invite and the team must be in the same workspace, and deleting either removes the row.
 */
export const inviteTeams = table(
  "invite_teams",
  {
    inviteId: uuid("invite_id").notNull(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    role: text("role", { enum: TEAM_ROLES }).notNull().default("editor"),
  },
  (t) => [
    primaryKey({ columns: [t.inviteId, t.teamId] }),
    teamScope("invite_teams", t),
    foreignKey({ name: "invite_teams_invite_fk", columns: [t.inviteId, t.workspaceId], foreignColumns: [invites.id, invites.workspaceId] }).onDelete("cascade"),
  ],
);

export const apiKeys = table("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(), // first chars, shown in UI
  keyHash: text("key_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // The scopes this key holds (KEY_SCOPES). New keys read and write the board and the map; "docs:write" (WH-51) and "planning:write" are granted by a teammate.
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([...DEFAULT_KEY_SCOPES]),
  createdAt: createdAt(),
}, (t) => [unique("api_keys_id_workspace_id_unique").on(t.id, t.workspaceId)]);

/**
 * The teams an agent key can open (WH-120). A key reaches a team only through a row here, as an editor; a key with no rows reaches
 * nothing. Both ends are in the key's own workspace (composite keys), and deleting the key or the team deletes the row.
 */
export const apiKeyTeams = table(
  "api_key_teams",
  {
    apiKeyId: uuid("api_key_id").notNull(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.apiKeyId, t.teamId] }),
    teamScope("api_key_teams", t),
    foreignKey({ name: "api_key_teams_key_fk", columns: [t.apiKeyId, t.workspaceId], foreignColumns: [apiKeys.id, apiKeys.workspaceId] }).onDelete("cascade"),
    index("api_key_teams_team_idx").on(t.teamId),
  ],
);
