import { uuid, text, timestamp, integer, jsonb, bigserial, primaryKey, index, unique, foreignKey, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { table, createdAt, updatedAt } from "./common";
import { teamScope } from "./team-scope";
import { users, workspaces, memberships } from "./auth";
import { repositories } from "./github";
import { issues } from "./issues";

/**
 * A machine someone paired with their workspace to run agent jobs on (the Wheelhouse daemon). It belongs to one person: only they
 * can send it work. The server keeps the device's Ed25519 public key; the private key never leaves the machine. A revoked device
 * keeps its row (its jobs still point at it) but can no longer get a token.
 */
export const devices = table(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id").notNull(),
    name: text("name").notNull(),
    os: text("os").notNull(),
    // Raw 32-byte Ed25519 public key, base64url.
    publicKey: text("public_key").notNull().unique(),
    daemonVersion: text("daemon_version"),
    // What the machine can run, from its latest hello (claude installed and signed in, models, repositories it holds).
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    // The most jobs it runs at once; the daemon enforces it.
    poolSize: integer("pool_size").notNull().default(3),
    // The model the chat agent uses (phase 2); null is the daemon's default.
    chatModel: text("chat_model"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("devices_id_workspace_id_unique").on(t.id, t.workspaceId),
    // Leaving the workspace removes the person's devices.
    foreignKey({ name: "devices_owner_membership_fk", columns: [t.ownerId, t.workspaceId], foreignColumns: [memberships.userId, memberships.workspaceId] }).onDelete("cascade"),
    index("devices_owner_idx").on(t.ownerId, t.workspaceId),
    check("devices_pool_size_check", sql`"pool_size" between 1 and 8`),
  ],
);

export const DEVICE_PAIRING_STATES = ["pending", "approved", "denied", "consumed"] as const;

/**
 * One run of the device authorization flow (RFC 8628). The daemon holds `device_code` (only its sha256 is stored) and polls; the
 * person types `user_code` in Wheelhouse and approves, which creates the device. A pairing lives ten minutes.
 */
export const devicePairings = table("device_pairings", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  publicKey: text("public_key").notNull(),
  name: text("name").notNull(),
  os: text("os").notNull(),
  state: text("state", { enum: DEVICE_PAIRING_STATES }).notNull().default("pending"),
  deviceId: uuid("device_id").references(() => devices.id, { onDelete: "cascade" }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/**
 * Short-lived access tokens a device gets by signing an assertion with its key (only the sha256 is stored). `jti` is the assertion's
 * id: unique, so an assertion can be exchanged once.
 */
export const deviceTokens = table(
  "device_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    jti: text("jti").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("device_tokens_device_idx").on(t.deviceId)],
);

export const DEVICE_MESSAGE_TYPES = ["job.offer", "job.cancel", "settings.update"] as const;

/**
 * What the server has told a device, in order: the device's stream replays it from `Last-Event-ID`. Each message is signed with the
 * server's key (`signature` over the canonical JSON of `message`), so the daemon runs nothing it cannot verify.
 */
export const deviceMessages = table(
  "device_messages",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    deviceId: uuid("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    type: text("type", { enum: DEVICE_MESSAGE_TYPES }).notNull(),
    message: jsonb("message").$type<Record<string, unknown>>().notNull(),
    signature: text("signature").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("device_messages_device_seq_idx").on(t.deviceId, t.seq)],
);

export const DEVICE_JOB_STATES = ["offered", "accepted", "running", "unreachable", "succeeded", "failed", "canceled", "rejected", "expired", "lost"] as const;

export type DeviceJobState = (typeof DEVICE_JOB_STATES)[number];

/**
 * One "Run on device": an issue worked on by an agent on someone's machine, in a worktree of one of the team's repositories. Every run
 * is its own row, so an issue keeps its history and can be run again.
 */
export const deviceJobs = table(
  "device_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    state: text("state", { enum: DEVICE_JOB_STATES }).notNull().default("offered"),
    branch: text("branch").notNull(),
    // The branch the job's branch starts from: chosen when it is run, the repository's default branch unless someone picks another.
    // A continuation keeps its first run's base, which is what its pull request targets.
    baseBranch: text("base_branch"),
    // The run this one carries on from ("Continue"): it works on that run's branch, from its commits. Null for a fresh run.
    continuesJobId: uuid("continues_job_id").references((): AnyPgColumn => deviceJobs.id, { onDelete: "set null" }),
    // What the daemon reported at the end: commit, diff stats, cost.
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    createdBy: uuid("created_by"),
    offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }).notNull(),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    // Set while the device has gone quiet (state `unreachable`): when the server noticed. Nothing is guessed from silence; a run only
    // becomes `lost` on the daemon's word, a revoked device, or a person marking it.
    unreachableSince: timestamp("unreachable_since", { withTimezone: true }),
    // Who marked an unreachable run lost by hand. Null for a run lost on evidence, so a late report from the device can tell the two apart.
    markedLostBy: uuid("marked_lost_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    teamScope("device_jobs", t),
    foreignKey({ name: "device_jobs_device_fk", columns: [t.deviceId, t.workspaceId], foreignColumns: [devices.id, devices.workspaceId] }).onDelete("cascade"),
    foreignKey({ name: "device_jobs_issue_fk", columns: [t.issueId, t.teamId], foreignColumns: [issues.id, issues.teamId] }).onDelete("cascade"),
    index("device_jobs_issue_idx").on(t.issueId),
    index("device_jobs_device_state_idx").on(t.deviceId, t.state),
  ],
);

/** A job's progress as the daemon reported it, numbered by the daemon so a retried batch is stored once. */
export const deviceJobEvents = table(
  "device_job_events",
  {
    jobId: uuid("job_id").notNull().references(() => deviceJobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.seq] })],
);

/** Keys the instance generates for itself and keeps (the daemon message signing key), when no environment variable provides one. */
export const instanceKeys = table("instance_keys", {
  name: text("name").primaryKey(),
  privateKey: text("private_key").notNull(),
  publicKey: text("public_key").notNull(),
  createdAt: createdAt(),
});
