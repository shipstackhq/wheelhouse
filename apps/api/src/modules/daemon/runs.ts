import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { DeviceJobState } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { github } from "../github/index";
import { serverSigningKey } from "./daemon-crypto";
import { ServiceError } from "../../common/service-error";
import { type Q } from "../../platform/database/transaction";
import { resolveIssue } from "../issues/index";
import { isUuid } from "../../common/uuid";
import { ACTIVE, OFFER_TTL_MS, isFinalState, str } from "./device-common";
import { sendToDevice, signalJob, wake } from "./device-stream";
import { transition } from "./job-state";
import { deviceOnline, deviceView, listDevices, ownDevice } from "./devices";

/** A person's runs on an issue: start, list, follow, stop, mark lost. See wheelhouse-cli/daemon/DESIGN.md. */
const { devices, deviceJobs, deviceJobEvents, issues, repositories, teams } = schema;

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** `wh/WH-12-fix-the-login-3f2a1c`: the issue ref (so the GitHub App links it), its title, and a bit of the job id, since an issue can run again. */
export const jobBranch = (ref: string, title: string, jobId: string) => `wh/${[ref, slugify(title), jobId.replace(/-/g, "").slice(0, 6)].filter(Boolean).join("-")}`;

/** What a run left behind, apart from how it ended: nothing, a pushed branch, an open pull request, or a branch whose pull request GitHub refused. */
export type JobDelivery = "none" | "pushed" | "pr_opened" | "pr_failed";

/**
 * Derived from what the run recorded, so it needs no column of its own. Null while a run has not finished (or was never taken up),
 * because it has nothing to report yet. A pull request is opened a moment after the run finishes, so a pushed run reads `pushed`
 * until that attempt lands.
 */
export function jobDelivery(state: DeviceJobState, result: Record<string, unknown>): JobDelivery | null {
  if (result.pullRequest) return "pr_opened";
  if (result.pullRequestError) return "pr_failed";
  if (result.pushed === true) return "pushed";
  return state === "succeeded" || state === "failed" || state === "canceled" ? "none" : null;
}

export function jobView(j: typeof deviceJobs.$inferSelect, extra: { deviceName?: string | null; repositoryName?: string | null; lastHeardAt?: Date | null } = {}) {
  return {
    id: j.id,
    state: j.state,
    model: j.model,
    branch: j.branch,
    baseBranch: j.baseBranch,
    continuesJobId: j.continuesJobId,
    deviceId: j.deviceId,
    deviceName: extra.deviceName ?? null,
    repositoryId: j.repositoryId,
    repositoryName: extra.repositoryName ?? null,
    result: j.result,
    delivery: jobDelivery(j.state, j.result),
    error: j.error,
    cancelRequested: !!j.cancelRequestedAt,
    // While unreachable: when the server noticed, and when the device was last heard. `markedLost`: a person ended it, not evidence.
    unreachableSince: j.unreachableSince?.toISOString() ?? null,
    lastHeardAt: j.state === "unreachable" ? (extra.lastHeardAt?.toISOString() ?? null) : null,
    markedLost: !!j.markedLostBy,
    createdAt: j.createdAt.toISOString(),
    acceptedAt: j.acceptedAt?.toISOString() ?? null,
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}
export type JobView = ReturnType<typeof jobView>;

/** The repositories of a team an agent can work in from a fresh clone: connected to GitHub and not retired. */
export async function runnableRepositories(q: Q, teamId: string) {
  const rows = await q.select().from(repositories).where(and(eq(repositories.teamId, teamId), eq(repositories.provider, "github")));
  return rows.filter((r) => r.githubFullName && r.lifecycle !== "retired");
}

/**
 * The issue's runs, newest first, and what a new one can use: the person's own online devices, the team's GitHub repositories, and
 * the models each device offers. Anyone who can read the issue sees its runs.
 */
export async function issueJobs(actor: Actor, ref: string) {
  const db = await getDb();
  const { issue, team } = await resolveIssue(actor, ref, db);
  const rows = await db
    .select({ job: deviceJobs, deviceName: devices.name, lastHeardAt: devices.lastSeenAt, repositoryName: repositories.displayName })
    .from(deviceJobs)
    .innerJoin(devices, eq(devices.id, deviceJobs.deviceId))
    .leftJoin(repositories, eq(repositories.id, deviceJobs.repositoryId))
    .where(and(eq(deviceJobs.issueId, issue.id), eq(deviceJobs.teamId, team.id)))
    .orderBy(desc(deviceJobs.createdAt))
    .limit(50);
  const repos = await runnableRepositories(db, team.id);
  const mine = actor.kind === "human" ? await listDevices(actor) : [];
  return {
    jobs: rows.map((r) => jobView(r.job, { deviceName: r.deviceName, repositoryName: r.repositoryName, lastHeardAt: r.lastHeardAt })),
    devices: mine.map((d) => ({ id: d.id, name: d.name, status: d.status, models: d.models, poolSize: d.poolSize, activeJobs: d.activeJobs })),
    repositories: repos.map((r) => ({ id: r.id, name: r.displayName, fullName: r.githubFullName, defaultBranch: r.defaultBranch })),
  };
}

/** A branch name a run may start from: what git accepts, without the tricks (`..`, a leading `-`, `@{`). */
export function validBaseBranch(v: unknown): string | null {
  const s = str(v, 200);
  if (!s || !/^[A-Za-z0-9._\/-]+$/.test(s) || s.startsWith("-") || s.startsWith("/") || s.endsWith("/") || s.endsWith(".lock") || s.includes("..") || s.includes("//")) return null;
  return s;
}

/**
 * The branches a run of the issue can start from, in one of its team's repositories: from GitHub when the server has the App, the
 * default branch first. Without GitHub (or when it fails) just the default branch, and `listed: false` so the page offers a text box.
 */
export async function runBranches(actor: Actor, ref: string, repositoryId: string) {
  const db = await getDb();
  const { team } = await resolveIssue(actor, ref, db);
  const repo = (await runnableRepositories(db, team.id)).find((r) => r.id === repositoryId);
  if (!repo) throw new ServiceError("not_found", "Repository not found");
  const def = repo.defaultBranch || "main";
  const gh = github();
  if (!gh || !repo.githubInstallationId || !repo.githubRepoId) return { defaultBranch: def, branches: [def], listed: false };
  try {
    const names = await gh.api.branches(repo.githubInstallationId, repo.githubRepoId);
    return { defaultBranch: def, branches: [def, ...names.filter((n) => n !== def).sort()], listed: true };
  } catch {
    return { defaultBranch: def, branches: [def], listed: false };
  }
}

/**
 * The earlier run a "Continue" carries on from: one of this issue's runs that has finished and pushed its branch, with no other run on
 * that branch right now (two agents on one branch would push over each other). Its final summary is handed to the new run.
 */
export async function continuable(q: Q, issueId: string, jobId: unknown) {
  const id = str(jobId, 60);
  const [job] = isUuid(id) ? await q.select().from(deviceJobs).where(and(eq(deviceJobs.id, id), eq(deviceJobs.issueId, issueId))) : [];
  if (!job) throw new ServiceError("invalid", "There is no such run of this issue to continue", { fields: { continuesJobId: "a run of this issue" } });
  if (job.state === "unreachable") throw new ServiceError("conflict", "That run cannot be reached. If it is gone, mark it lost first, then continue it");
  if (!isFinalState(job.state)) throw new ServiceError("conflict", "That run has not finished yet");
  // A run that was stopped or lost can be picked up again even if it never pushed; any other run needs a push to continue from.
  const pushed = job.result?.pushed === true;
  if (!pushed && job.state !== "canceled" && job.state !== "lost") throw new ServiceError("invalid", "That run pushed nothing, so there is nothing to continue from: start over instead");
  const [busy] = await q.select({ id: deviceJobs.id }).from(deviceJobs).where(and(eq(deviceJobs.branch, job.branch), inArray(deviceJobs.state, ACTIVE))).limit(1);
  if (busy) throw new ServiceError("conflict", "Another run is already working on that branch");
  const [last] = await q
    .select({ data: deviceJobEvents.data })
    .from(deviceJobEvents)
    .where(and(eq(deviceJobEvents.jobId, job.id), eq(deviceJobEvents.type, "result")))
    .orderBy(desc(deviceJobEvents.seq))
    .limit(1);
  const summary = typeof last?.data?.text === "string" ? (last.data.text as string) : null;
  return { job, summary, pushed };
}

/**
 * "Run on device": `{ deviceId, repositoryId?, model, baseBranch?, continuesJobId? }`. With `continuesJobId` the new run works on that
 * earlier run's branch, from its commits, with the same repository and pull request target; otherwise it starts a new branch. The person must be able to edit the issue and own the device, which must be
 * online. The repository is one of the issue team's GitHub repositories (the only one, if the team has one). The job is offered to
 * the device as a signed message carrying everything it needs, and expires if the device does not take it within a minute.
 */
export async function runOnDevice(actor: Actor, ref: string, input: Record<string, unknown>) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can send work to their machine");
  const db = await getDb();
  const { issue, team, ref: issueRef } = await resolveIssue(actor, ref, db, "edit");
  const device = await ownDevice(actor, str(input.deviceId, 60), db).catch(() => {
    throw new ServiceError("invalid", "Pick one of your devices", { fields: { deviceId: "one of your paired devices" } });
  });
  if (!deviceOnline(device)) throw new ServiceError("conflict", `${device.name} is offline. Start the daemon on it and try again.`);
  const repos = await runnableRepositories(db, team.id);
  // "Continue": carry on from an earlier run of this issue, on its branch and from its commits, with what it said at the end.
  const previous = input.continuesJobId === undefined || input.continuesJobId === null ? null : await continuable(db, issue.id, input.continuesJobId);
  const repoId = previous ? (previous.job.repositoryId ?? "") : str(input.repositoryId, 60);
  const repo = repoId ? repos.find((r) => r.id === repoId) : repos.length === 1 ? repos[0] : undefined;
  if (!repo)
    throw new ServiceError("invalid", repos.length ? "Pick the repository to work in" : "This team has no GitHub repository the agent can clone yet", {
      fields: { repositoryId: repos.length ? "one of the team's GitHub repositories" : "connect a GitHub repository first" },
    });
  const view = deviceView(device);
  const model = str(input.model, 60);
  if (!model || !view.models.includes(model)) throw new ServiceError("invalid", `Pick a model ${device.name} offers: ${view.models.join(", ")}`, { fields: { model: view.models.join(", ") } });
  const baseBranch = previous
    ? previous.job.baseBranch || repo.defaultBranch || "main"
    : input.baseBranch === undefined || input.baseBranch === ""
      ? repo.defaultBranch || "main"
      : validBaseBranch(input.baseBranch);
  if (!baseBranch) throw new ServiceError("invalid", "That is not a branch name", { fields: { baseBranch: "a branch of the repository" } });

  const id = crypto.randomUUID();
  const branch = previous ? previous.job.branch : jobBranch(issueRef, issue.title, id);
  const offerExpiresAt = new Date(Date.now() + OFFER_TTL_MS);
  const key = await serverSigningKey();
  const job = await db.transaction(async (tx) => {
    const [j] = await tx
      .insert(deviceJobs)
      .values({ id, teamId: team.id, workspaceId: actor.workspaceId, deviceId: device.id, issueId: issue.id, repositoryId: repo.id, model, branch, baseBranch, continuesJobId: previous?.job.id ?? null, createdBy: actor.id, offerExpiresAt })
      .returning();
    await sendToDevice(tx, key, device.id, "job.offer", {
      jobId: j.id,
      expiresAt: offerExpiresAt.toISOString(),
      model,
      branch,
      baseBranch,
      // Where the worktree starts: the earlier run's pushed branch when continuing, else the base (also when a stopped or lost run never pushed).
      startFrom: previous?.pushed ? branch : baseBranch,
      previous: previous ? { jobId: previous.job.id, state: previous.job.state, summary: previous.summary, error: previous.job.error } : null,
      // Board writes come with the MCP redesign; until then the agent works only in its worktree.
      boardAccess: "none",
      issue: { id: issue.id, ref: issueRef, title: issue.title, body: issue.body, team: { key: team.key, name: team.name } },
      repository: {
        id: repo.id,
        name: repo.displayName,
        fullName: repo.githubFullName,
        cloneUrl: `https://github.com/${repo.githubFullName}.git`,
        defaultBranch: repo.defaultBranch,
        pathLimit: repo.pathLimit,
      },
      requestedBy: { id: actor.id, name: actor.name },
    });
    return j;
  });
  wake(device.id);
  signalJob(job);
  return { job: jobView(job, { deviceName: device.name, repositoryName: repo.displayName }) };
}

/** A job the actor can read, through its issue's team. */
export async function readableJob(actor: Actor, jobId: string) {
  if (!isUuid(jobId)) throw new ServiceError("not_found", "Job not found");
  const db = await getDb();
  const [row] = await db
    .select({ job: deviceJobs, issueNumber: issues.number, teamKey: teams.key })
    .from(deviceJobs)
    .innerJoin(issues, eq(issues.id, deviceJobs.issueId))
    .innerJoin(teams, eq(teams.id, deviceJobs.teamId))
    .where(and(eq(deviceJobs.id, jobId), eq(deviceJobs.workspaceId, actor.workspaceId)));
  if (!row) throw new ServiceError("not_found", "Job not found");
  await resolveIssue(actor, `${row.teamKey}-${row.issueNumber}`, db).catch(() => {
    throw new ServiceError("not_found", "Job not found");
  });
  return row.job;
}

/** A job's progress after event `after` (exclusive), oldest first, at most `limit`. */
export async function jobEvents(actor: Actor, jobId: string, opts: { after?: number; limit?: number } = {}) {
  const job = await readableJob(actor, jobId);
  const db = await getDb();
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const rows = await db
    .select()
    .from(deviceJobEvents)
    .where(and(eq(deviceJobEvents.jobId, job.id), gt(deviceJobEvents.seq, opts.after ?? -1)))
    .orderBy(asc(deviceJobEvents.seq))
    .limit(limit);
  const [dev] = job.state === "unreachable" ? await db.select({ lastSeenAt: devices.lastSeenAt }).from(devices).where(eq(devices.id, job.deviceId)) : [];
  return { job: jobView(job, { lastHeardAt: dev?.lastSeenAt }), events: rows.map((e) => ({ seq: e.seq, at: e.at.toISOString(), type: e.type, data: e.data })) };
}

/**
 * Stop a job. An offer not yet taken ends at once; a job the daemon holds is asked to stop (a signed cancel) and ends when the daemon
 * reports it. The person who started it, or the device's owner, can cancel.
 */
export async function cancelJob(actor: Actor, jobId: string) {
  const job = await readableJob(actor, jobId);
  const db = await getDb();
  const [d] = await db.select().from(devices).where(eq(devices.id, job.deviceId));
  if (actor.kind !== "human" || (job.createdBy !== actor.id && d?.ownerId !== actor.id)) throw new ServiceError("forbidden", "Only the person who started it or the device's owner can cancel a run");
  if (isFinalState(job.state)) return { job: jobView(job) };
  const now = new Date();
  const key = await serverSigningKey();
  const updated = await db.transaction(async (tx) => {
    const [row] =
      job.state === "offered"
        ? await tx
            .update(deviceJobs)
            .set({ state: "canceled", cancelRequestedAt: now, finishedAt: now, updatedAt: now, error: `Canceled by ${actor.name}` })
            .where(and(eq(deviceJobs.id, job.id), eq(deviceJobs.state, "offered")))
            .returning()
        : await tx
            .update(deviceJobs)
            .set({ cancelRequestedAt: now, updatedAt: now })
            .where(and(eq(deviceJobs.id, job.id), inArray(deviceJobs.state, ["accepted", "running", "unreachable"])))
            .returning();
    if (row) await sendToDevice(tx, key, job.deviceId, "job.cancel", { jobId: job.id, requestedBy: { id: actor.id, name: actor.name } });
    return row;
  });
  wake(job.deviceId);
  if (updated) signalJob(updated);
  return { job: jobView(updated ?? job) };
}

/**
 * Mark an unreachable run lost, by hand: the person decides it is not coming back, which frees its branch to continue. Only an
 * unreachable run can be marked, by the device's owner or someone who can edit the issue. It is a guess, so it is not final: if the
 * device reports the run after all, it comes back (or, if a newer run took the branch, it is stopped; see `reconcileJobs`).
 */
export async function markJobLost(actor: Actor, jobId: string) {
  const job = await readableJob(actor, jobId);
  const db = await getDb();
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can mark a run lost");
  const [d] = await db.select().from(devices).where(eq(devices.id, job.deviceId));
  if (d?.ownerId !== actor.id) {
    const [i] = await db.select({ number: issues.number, key: teams.key }).from(issues).innerJoin(teams, eq(teams.id, issues.teamId)).where(eq(issues.id, job.issueId));
    await resolveIssue(actor, `${i.key}-${i.number}`, db, "edit");
  }
  if (job.state === "lost") return { job: jobView(job, { deviceName: d?.name }) };
  if (job.state !== "unreachable") throw new ServiceError("conflict", "Only a run that cannot be reached can be marked lost");
  const row = await transition(job.id, ["unreachable"], { state: "lost", finishedAt: new Date(), markedLostBy: actor.id, error: `Marked lost by ${actor.name}` });
  if (!row) throw new ServiceError("conflict", "The device reconnected, so the run is not lost");
  return { job: jobView(row, { deviceName: d?.name }) };
}
