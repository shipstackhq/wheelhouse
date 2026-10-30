import type { schema } from "../../db";
import type { DeviceJobState } from "../../db/schema";

/** Constants, the job states and the small helpers every part of the daemon module shares. See wheelhouse-cli/daemon/DESIGN.md. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** How often the daemon may poll a pairing; faster polls are told to slow down (RFC 8628). */
export const PAIRING_POLL_INTERVAL_S = 5;
export const TOKEN_TTL_S = 15 * 60;
/** An offer the device has not accepted by then is expired. */
export const OFFER_TTL_MS = 60_000;
/** A device that has not been heard from for this long is offline: no new offers. */
export const ONLINE_WINDOW_MS = 90_000;
/** A job whose device has been silent this long is unreachable. Silence alone never loses a job: it may be a closed laptop or a dropped connection. */
export const UNREACHABLE_AFTER_MS = 3 * 60_000;
export const MAX_POOL_SIZE = 8;
export const MAX_EVENTS_PER_JOB = 5_000;
export const MAX_EVENTS_PER_BATCH = 200;
/** The models a job may ask for when the device has not listed its own (aliases the claude CLI understands). */
export const DEFAULT_MODELS = ["opus", "sonnet", "haiku"];

export const ACTIVE: DeviceJobState[] = ["offered", "accepted", "running", "unreachable"];
export const FINAL: DeviceJobState[] = ["succeeded", "failed", "canceled", "rejected", "expired", "lost"];
export const isFinalState = (s: DeviceJobState) => FINAL.includes(s);

export type Device = typeof schema.devices.$inferSelect;

export const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A chat answer no event has started by this long after it was sent is failed; one that then goes quiet this long is too. */
export const CHAT_PENDING_MS = 60_000;
export const CHAT_QUIET_MS = 3 * 60_000;
/** The latest tool calls an answer keeps, and the most characters of one answer. */
/** The daemon's CHAT_TIMEOUT: a chat answer's key never outlives it. */
export const CHAT_KEY_TTL_MS = 10 * 60_000;
/** A run's read-only Wheelhouse key: dropped when the run ends, and expires by itself after this in case the end never arrives. */
export const RUN_KEY_TTL_MS = 6 * 60 * 60_000;
export const CHAT_ACTIVITY_MAX = 30;
export const CHAT_CONTENT_MAX = 400_000;
export const CHAT_MESSAGE_MAX = 100_000;
