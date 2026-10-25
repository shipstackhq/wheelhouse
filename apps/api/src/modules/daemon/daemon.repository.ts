import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { schema } from "../../db";
import type { ChatMessageState, DeviceJobState } from "../../db/schema";
import { Database } from "../../platform/database/database";

const { devices, devicePairings, deviceTokens, deviceMessages, deviceJobs, deviceJobEvents, instanceKeys, workspaces, issues, teams, repositories, chatThreads, chatMessages } = schema;

export type DeviceRow = typeof devices.$inferSelect;
export type PairingRow = typeof devicePairings.$inferSelect;
export type MessageRow = typeof deviceMessages.$inferSelect;
export type JobRow = typeof deviceJobs.$inferSelect;
export type JobInsert = typeof deviceJobs.$inferInsert;
export type JobPatch = Partial<JobInsert>;
export type ChatThreadRow = typeof chatThreads.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatMessagePatch = Partial<typeof chatMessages.$inferInsert>;

/**
 * Every query on the daemon module's tables (devices, device_pairings, device_tokens, device_messages, device_jobs, device_job_events,
 * instance_keys), and the only file of the module that touches Drizzle. Each method reads `this.db.q`, so it runs on the current
 * transaction when a service opened one. It decides nothing: the rules are in the services and in daemon.rules.ts.
 *
 * A chat thread is reached by thread id AND its owner AND the caller's workspace id (the person's side), a chat message by message id AND
 * the token's device id (the machine's side). The thread list joins the team (its key), the device and the repository (names), read only.
 *
 * Three reads join another area's table, read only: a device's workspace (its name and whether it is suspended), and the issue, team
 * and repository a job's pull request is opened for. The machine side runs in a process of its own (SERVICE_ROLE=daemon) and may not
 * call the other modules, so it reads these rows itself; it writes none of them.
 *
 * A device is reached by its own id: a job by job id AND device id, a message by device id. A person's device is selected by owner id
 * AND workspace id, a job by job id AND workspace id (then through its issue's team, in the service).
 */
@Injectable()
export class DaemonRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── devices ─────────

  /** A device with whether its workspace is suspended. */
  async deviceWithSuspension(id: string) {
    const [row] = await this.db.q
      .select({ device: devices, suspendedAt: workspaces.suspendedAt })
      .from(devices)
      .innerJoin(workspaces, eq(workspaces.id, devices.workspaceId))
      .where(eq(devices.id, id));
    return row;
  }

  /** A device with its workspace row (for the answer a paired machine gets once). */
  async deviceWithWorkspace(id: string) {
    const [row] = await this.db.q
      .select({ device: devices, workspace: workspaces })
      .from(devices)
      .innerJoin(workspaces, eq(workspaces.id, devices.workspaceId))
      .where(eq(devices.id, id));
    return row;
  }

  async deviceByPublicKey(publicKey: string) {
    const [d] = await this.db.q.select().from(devices).where(eq(devices.publicKey, publicKey));
    return d;
  }

  async deviceById(id: string) {
    const [d] = await this.db.q.select().from(devices).where(eq(devices.id, id));
    return d;
  }

  async insertDevice(values: typeof devices.$inferInsert) {
    const [d] = await this.db.q.insert(devices).values(values).returning();
    return d;
  }

  async updateDevice(id: string, set: Partial<typeof devices.$inferInsert>) {
    const [d] = await this.db.q.update(devices).set(set).where(eq(devices.id, id)).returning();
    return d;
  }

  async revokeDevice(id: string, at: Date) {
    await this.db.q.update(devices).set({ revokedAt: at }).where(eq(devices.id, id));
  }

  /** A person's own device, not revoked: owner id AND workspace id. */
  async ownDevice(ownerId: string, workspaceId: string, id: string) {
    const [d] = await this.db.q.select().from(devices).where(and(eq(devices.id, id), eq(devices.ownerId, ownerId), eq(devices.workspaceId, workspaceId), isNull(devices.revokedAt)));
    return d;
  }

  listOwnDevices(ownerId: string, workspaceId: string) {
    return this.db.q
      .select()
      .from(devices)
      .where(and(eq(devices.ownerId, ownerId), eq(devices.workspaceId, workspaceId), isNull(devices.revokedAt)))
      .orderBy(asc(devices.createdAt));
  }

  /** How many active jobs each of the devices is running. */
  activeJobCounts(deviceIds: string[], active: DeviceJobState[]) {
    return this.db.q
      .select({ deviceId: deviceJobs.deviceId, n: sql<number>`count(*)::int` })
      .from(deviceJobs)
      .where(and(inArray(deviceJobs.deviceId, deviceIds), inArray(deviceJobs.state, active)))
      .groupBy(deviceJobs.deviceId);
  }

  // ───────── tokens ─────────

  /** The device behind a token that has not expired, with whether its workspace is suspended. */
  async deviceForTokenHash(tokenHash: string, now: Date) {
    const [row] = await this.db.q
      .select({ device: devices, suspendedAt: workspaces.suspendedAt })
      .from(deviceTokens)
      .innerJoin(devices, eq(devices.id, deviceTokens.deviceId))
      .innerJoin(workspaces, eq(workspaces.id, devices.workspaceId))
      .where(and(eq(deviceTokens.tokenHash, tokenHash), gt(deviceTokens.expiresAt, now)));
    return row;
  }

  async deleteExpiredTokens(deviceId: string, now: Date) {
    await this.db.q.delete(deviceTokens).where(and(eq(deviceTokens.deviceId, deviceId), lt(deviceTokens.expiresAt, now)));
  }

  async deleteTokens(deviceId: string) {
    await this.db.q.delete(deviceTokens).where(eq(deviceTokens.deviceId, deviceId));
  }

  /** Stores a token; an empty answer means the assertion (`jti`) was used before. */
  insertToken(values: typeof deviceTokens.$inferInsert) {
    return this.db.q.insert(deviceTokens).values(values).onConflictDoNothing().returning();
  }

  // ───────── pairings ─────────

  async deleteOldPairings(before: Date) {
    await this.db.q.delete(devicePairings).where(lt(devicePairings.expiresAt, before));
  }

  async insertPairing(values: typeof devicePairings.$inferInsert) {
    await this.db.q.insert(devicePairings).values(values);
  }

  async pairingByDeviceCodeHash(hash: string) {
    const [p] = await this.db.q.select().from(devicePairings).where(eq(devicePairings.deviceCodeHash, hash));
    return p;
  }

  async pairingByUserCode(code: string) {
    const [p] = await this.db.q.select().from(devicePairings).where(eq(devicePairings.userCode, code));
    return p;
  }

  async touchPairing(id: string, at: Date) {
    await this.db.q.update(devicePairings).set({ lastPolledAt: at }).where(eq(devicePairings.id, id));
  }

  /** Moves a pairing from `from` to `to`; nothing when something else got there first. */
  async movePairing(id: string, from: PairingRow["state"], to: PairingRow["state"]) {
    const [p] = await this.db.q
      .update(devicePairings)
      .set({ state: to })
      .where(and(eq(devicePairings.id, id), eq(devicePairings.state, from)))
      .returning();
    return p;
  }

  async setPairingDevice(id: string, deviceId: string) {
    await this.db.q.update(devicePairings).set({ deviceId }).where(eq(devicePairings.id, id));
  }

  // ───────── messages ─────────

  async insertMessage(values: typeof deviceMessages.$inferInsert) {
    await this.db.q.insert(deviceMessages).values(values);
  }

  messagesAfter(deviceId: string, seq: number, limit: number) {
    return this.db.q.select().from(deviceMessages).where(and(eq(deviceMessages.deviceId, deviceId), gt(deviceMessages.seq, seq))).orderBy(asc(deviceMessages.seq)).limit(limit);
  }

  async deviceRevokedAt(id: string) {
    const [d] = await this.db.q.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, id));
    return d;
  }

  async deviceLastSeen(id: string) {
    const [d] = await this.db.q.select({ lastSeenAt: devices.lastSeenAt }).from(devices).where(eq(devices.id, id));
    return d;
  }

  // ───────── jobs ─────────

  /** A device's own job: job id AND device id. */
  async jobOfDevice(jobId: string, deviceId: string) {
    const [j] = await this.db.q.select().from(deviceJobs).where(and(eq(deviceJobs.id, jobId), eq(deviceJobs.deviceId, deviceId)));
    return j;
  }

  /** Moves a job to the patch's state only if it is still in one of `from`; nothing when something else got there first. */
  async moveJob(jobId: string, from: DeviceJobState[], set: JobPatch & { state: DeviceJobState }) {
    const [row] = await this.db.q
      .update(deviceJobs)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(deviceJobs.id, jobId), inArray(deviceJobs.state, from)))
      .returning();
    return row;
  }

  jobsOfDeviceInStates(deviceId: string, states: DeviceJobState[]) {
    return this.db.q.select().from(deviceJobs).where(and(eq(deviceJobs.deviceId, deviceId), inArray(deviceJobs.state, states)));
  }

  /** Jobs a person marked lost that the device still reports. */
  markedLostJobs(deviceId: string, ids: string[]) {
    return this.db.q
      .select()
      .from(deviceJobs)
      .where(and(eq(deviceJobs.deviceId, deviceId), eq(deviceJobs.state, "lost"), sql`${deviceJobs.markedLostBy} is not null`, inArray(deviceJobs.id, ids)));
  }

  /** The id of a newer run on the job's branch, one that was offered and not refused. */
  async newerRunOnBranch(j: JobRow) {
    const [t] = await this.db.q
      .select({ id: deviceJobs.id })
      .from(deviceJobs)
      .where(and(eq(deviceJobs.issueId, j.issueId), eq(deviceJobs.branch, j.branch), sql`${deviceJobs.id} <> ${j.id}`, gt(deviceJobs.createdAt, j.createdAt), notInArray(deviceJobs.state, ["rejected", "expired"])))
      .limit(1);
    return t?.id ?? null;
  }

  /** Asks a job's device to stop it, once. */
  async requestCancelOnce(jobId: string, at: Date) {
    const [row] = await this.db.q.update(deviceJobs).set({ cancelRequestedAt: at, updatedAt: at }).where(and(eq(deviceJobs.id, jobId), isNull(deviceJobs.cancelRequestedAt))).returning();
    return row;
  }

  async insertJob(values: JobInsert) {
    const [j] = await this.db.q.insert(deviceJobs).values(values).returning();
    return j;
  }

  /** A job in the actor's workspace. */
  async jobInWorkspace(jobId: string, workspaceId: string) {
    const [j] = await this.db.q.select().from(deviceJobs).where(and(eq(deviceJobs.id, jobId), eq(deviceJobs.workspaceId, workspaceId)));
    return j;
  }

  /** An issue's runs, newest first, with the device's name and when it was last heard. */
  issueRuns(issueId: string, teamId: string) {
    return this.db.q
      .select({ job: deviceJobs, deviceName: devices.name, lastHeardAt: devices.lastSeenAt })
      .from(deviceJobs)
      .innerJoin(devices, eq(devices.id, deviceJobs.deviceId))
      .where(and(eq(deviceJobs.issueId, issueId), eq(deviceJobs.teamId, teamId)))
      .orderBy(desc(deviceJobs.createdAt))
      .limit(50);
  }

  async jobOfIssue(jobId: string, issueId: string) {
    const [j] = await this.db.q.select().from(deviceJobs).where(and(eq(deviceJobs.id, jobId), eq(deviceJobs.issueId, issueId)));
    return j;
  }

  async activeRunOnBranch(branch: string, active: DeviceJobState[]) {
    const [busy] = await this.db.q.select({ id: deviceJobs.id }).from(deviceJobs).where(and(eq(deviceJobs.branch, branch), inArray(deviceJobs.state, active))).limit(1);
    return busy;
  }

  /** What a run said at the end (its last `result` event). */
  async lastResultEvent(jobId: string) {
    const [last] = await this.db.q
      .select({ data: deviceJobEvents.data })
      .from(deviceJobEvents)
      .where(and(eq(deviceJobEvents.jobId, jobId), eq(deviceJobEvents.type, "result")))
      .orderBy(desc(deviceJobEvents.seq))
      .limit(1);
    return last;
  }

  /** An offer not yet taken ends at once. */
  async cancelOffer(jobId: string, at: Date, error: string) {
    const [row] = await this.db.q
      .update(deviceJobs)
      .set({ state: "canceled", cancelRequestedAt: at, finishedAt: at, updatedAt: at, error })
      .where(and(eq(deviceJobs.id, jobId), eq(deviceJobs.state, "offered")))
      .returning();
    return row;
  }

  /** A job the device holds is asked to stop. */
  async requestCancel(jobId: string, at: Date) {
    const [row] = await this.db.q
      .update(deviceJobs)
      .set({ cancelRequestedAt: at, updatedAt: at })
      .where(and(eq(deviceJobs.id, jobId), inArray(deviceJobs.state, ["accepted", "running", "unreachable"])))
      .returning();
    return row;
  }

  /** Cancels every job of a device that is still active (the device was unpaired). */
  cancelActiveJobsOfDevice(deviceId: string, active: DeviceJobState[], at: Date, error: string) {
    return this.db.q
      .update(deviceJobs)
      .set({ state: "canceled", finishedAt: at, updatedAt: at, error })
      .where(and(eq(deviceJobs.deviceId, deviceId), inArray(deviceJobs.state, active)))
      .returning();
  }

  // ───────── job events ─────────

  async insertEvents(rows: (typeof deviceJobEvents.$inferInsert)[]) {
    await this.db.q.insert(deviceJobEvents).values(rows).onConflictDoNothing();
  }

  eventsAfter(jobId: string, after: number, limit: number) {
    return this.db.q.select().from(deviceJobEvents).where(and(eq(deviceJobEvents.jobId, jobId), gt(deviceJobEvents.seq, after))).orderBy(asc(deviceJobEvents.seq)).limit(limit);
  }

  // ───────── the pull request of a finished run ─────────

  /** The issue, its team's key and the repository a run's pull request is for (read only, see the class comment). */
  async pullRequestContext(issueId: string, repositoryId: string) {
    const [row] = await this.db.q
      .select({ issue: issues, teamKey: teams.key, repo: repositories })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .innerJoin(repositories, eq(repositories.id, repositoryId))
      .where(eq(issues.id, issueId));
    return row;
  }

  /** What a run's notice names: its issue's number and title and its team's key and workspace. Read only; undefined when the issue is gone. */
  async issueForNotice(issueId: string) {
    const [row] = await this.db.q
      .select({ number: issues.number, title: issues.title, teamId: issues.teamId, workspaceId: issues.workspaceId, teamKey: teams.key })
      .from(issues)
      .innerJoin(teams, eq(teams.id, issues.teamId))
      .where(eq(issues.id, issueId));
    return row;
  }

  /** The pull request of an earlier run on the same branch and repository, if there is one. */
  async earlierPullRequest(j: JobRow) {
    const [earlier] = await this.db.q
      .select({ result: deviceJobs.result })
      .from(deviceJobs)
      .where(and(eq(deviceJobs.branch, j.branch), eq(deviceJobs.repositoryId, j.repositoryId!), sql`${deviceJobs.id} <> ${j.id}`, sql`${deviceJobs.result} ? 'pullRequest'`))
      .orderBy(desc(deviceJobs.createdAt))
      .limit(1);
    return earlier;
  }

  /** Adds keys to a run's result. */
  async mergeResult(jobId: string, patch: Record<string, unknown>) {
    const [updated] = await this.db.q
      .update(deviceJobs)
      .set({ result: sql`${deviceJobs.result} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
      .where(eq(deviceJobs.id, jobId))
      .returning();
    return updated;
  }

  // ───────── the sweep ─────────

  expireOffers(now: Date) {
    return this.db.q
      .update(deviceJobs)
      .set({ state: "expired", finishedAt: now, updatedAt: now })
      .where(and(eq(deviceJobs.state, "offered"), lt(deviceJobs.offerExpiresAt, now)))
      .returning();
  }

  /** Jobs of devices not heard from since `cutoff` become unreachable. */
  markUnreachable(now: Date, cutoff: Date) {
    const silent = this.db.q.select({ id: devices.id }).from(devices).where(or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, cutoff)));
    return this.db.q
      .update(deviceJobs)
      .set({ state: "unreachable", unreachableSince: now, updatedAt: now })
      .where(and(inArray(deviceJobs.state, ["accepted", "running"]), inArray(deviceJobs.deviceId, silent)))
      .returning();
  }

  // ───────── chats ─────────

  private threadSelect() {
    return {
      thread: chatThreads,
      teamKey: teams.key,
      repositoryName: repositories.displayName,
      deviceName: devices.name,
      deviceLastSeenAt: devices.lastSeenAt,
      deviceRevokedAt: devices.revokedAt,
      running: sql<boolean>`exists (select 1 from ${chatMessages} m where m.thread_id = ${chatThreads.id} and m.role = 'assistant' and m.state in ('pending', 'streaming'))`,
    };
  }

  private threadsWhere(where: SQL | undefined) {
    return this.db.q
      .select(this.threadSelect())
      .from(chatThreads)
      .innerJoin(teams, eq(teams.id, chatThreads.teamId))
      .innerJoin(devices, eq(devices.id, chatThreads.deviceId))
      .leftJoin(repositories, eq(repositories.id, chatThreads.repositoryId))
      .where(where);
  }

  /** The person's threads, newest first. */
  ownThreads(ownerId: string, workspaceId: string) {
    return this.threadsWhere(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.workspaceId, workspaceId))).orderBy(desc(chatThreads.updatedAt)).limit(200);
  }

  /** A thread of the person's own: thread id AND owner id AND workspace id. */
  async ownThread(id: string, ownerId: string, workspaceId: string) {
    const [row] = await this.threadsWhere(and(eq(chatThreads.id, id), eq(chatThreads.ownerId, ownerId), eq(chatThreads.workspaceId, workspaceId)));
    return row;
  }

  async insertThread(values: typeof chatThreads.$inferInsert) {
    const [t] = await this.db.q.insert(chatThreads).values(values).returning();
    return t;
  }

  async touchThread(id: string, set: { sessionId?: string; model?: string; updatedAt: Date }) {
    await this.db.q.update(chatThreads).set(set).where(eq(chatThreads.id, id));
  }

  async deleteThread(id: string) {
    await this.db.q.delete(chatThreads).where(eq(chatThreads.id, id));
  }

  threadMessages(threadId: string) {
    return this.db.q.select().from(chatMessages).where(eq(chatMessages.threadId, threadId)).orderBy(asc(chatMessages.seq));
  }

  async lastMessageSeq(threadId: string) {
    const [r] = await this.db.q.select({ n: sql<number>`coalesce(max(${chatMessages.seq}), 0)::int` }).from(chatMessages).where(eq(chatMessages.threadId, threadId));
    return r.n;
  }

  async insertMessages(rows: (typeof chatMessages.$inferInsert)[]) {
    return this.db.q.insert(chatMessages).values(rows).returning();
  }

  /** The thread's answer that is still being written, if any. */
  async runningAnswer(threadId: string) {
    const [m] = await this.db.q
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.role, "assistant"), inArray(chatMessages.state, ["pending", "streaming"])));
    return m;
  }

  /** A message and its thread, only when the thread is on this device: message id AND device id. */
  async messageOfDevice(messageId: string, deviceId: string) {
    const [row] = await this.db.q
      .select({ message: chatMessages, thread: chatThreads })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
      .where(and(eq(chatMessages.id, messageId), eq(chatThreads.deviceId, deviceId)));
    return row;
  }

  /** Changes a message only while it is still in one of `from` (and, when given, at that event number); nothing when something else got there first. */
  async moveMessage(id: string, from: ChatMessageState[], set: ChatMessagePatch, atEventSeq?: number) {
    const [row] = await this.db.q
      .update(chatMessages)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(chatMessages.id, id), inArray(chatMessages.state, from), atEventSeq === undefined ? undefined : eq(chatMessages.lastEventSeq, atEventSeq)))
      .returning();
    return row;
  }

  /** Answers nobody has started by `pendingBefore`, and ones that went quiet since `quietBefore`, fail with the reason. */
  async failStaleAnswers(pendingBefore: Date, quietBefore: Date, now: Date) {
    const stale = (state: ChatMessageState, when: Date, error: string, col: typeof chatMessages.createdAt | typeof chatMessages.updatedAt) =>
      this.db.q
        .update(chatMessages)
        .set({ state: "failed", error, updatedAt: now })
        .where(and(eq(chatMessages.role, "assistant"), eq(chatMessages.state, state), lt(col, when)))
        .returning();
    return [...(await stale("pending", pendingBefore, "Your device did not answer", chatMessages.createdAt)), ...(await stale("streaming", quietBefore, "Your device went quiet", chatMessages.updatedAt))];
  }

  async threadById(id: string) {
    const [t] = await this.db.q.select().from(chatThreads).where(eq(chatThreads.id, id));
    return t;
  }

  // ───────── the server's signing key ─────────

  async instanceKey(name: string) {
    const [row] = await this.db.q.select().from(instanceKeys).where(eq(instanceKeys.name, name));
    return row;
  }

  async insertInstanceKey(values: typeof instanceKeys.$inferInsert) {
    await this.db.q.insert(instanceKeys).values(values).onConflictDoNothing();
  }
}
