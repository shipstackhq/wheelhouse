import type { DeviceJobState } from "../../db/schema";
import { DEFAULT_MODELS, ONLINE_WINDOW_MS, type Device } from "./device-common";
import type { JobRow, MessageRow } from "./daemon.repository";

/** Row to API shape for devices and runs, and a signed message to its stream frame. Pure functions. */

export const deviceOnline = (d: Pick<Device, "lastSeenAt" | "revokedAt">, now = Date.now()) => !d.revokedAt && !!d.lastSeenAt && now - d.lastSeenAt.getTime() < ONLINE_WINDOW_MS;

export function deviceView(d: Device) {
  const caps = (d.capabilities ?? {}) as { claude?: { models?: string[] } };
  // A device that has reported lists exactly what it offers (none when claude is missing or signed out); the defaults are only for one
  // that has not said hello yet.
  return {
    id: d.id,
    name: d.name,
    os: d.os,
    status: d.revokedAt ? ("revoked" as const) : deviceOnline(d) ? ("online" as const) : ("offline" as const),
    poolSize: d.poolSize,
    chatModel: d.chatModel,
    daemonVersion: d.daemonVersion,
    capabilities: d.capabilities,
    models: caps.claude ? (caps.claude.models ?? []) : DEFAULT_MODELS,
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}
export type DeviceView = ReturnType<typeof deviceView>;

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

export function jobView(j: JobRow, extra: { deviceName?: string | null; repositoryName?: string | null; lastHeardAt?: Date | null } = {}) {
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

export const formatMessage = (m: MessageRow) => `id: ${m.seq}\nevent: ${m.type}\ndata: ${JSON.stringify({ message: m.message, signature: m.signature })}\n\n`;
