import type { ChatMessageView, ChatOptions } from "@wheelhouse/api-client";

/** The longest message the server takes. */
export const MAX_MESSAGE = 100_000;
/** A paste this long becomes a tile above the message box instead of filling it. */
export const PASTE_AS_TILE = 2000;

/** What is sent: the typed text, then each pasted block in `<pasted>` tags, so the model sees where it starts and ends and the thread can show it as a tile again. */
export const joinMessage = (text: string, pastes: string[]) => [text.trim(), ...pastes.map((p) => `<pasted>\n${p}\n</pasted>`)].filter(Boolean).join("\n\n");

/** A sent message back into its typed text and pasted blocks. */
export function splitMessage(content: string): { text: string; pastes: string[] } {
  const pastes: string[] = [];
  const text = content.replace(/<pasted>\n([\s\S]*?)\n<\/pasted>/g, (_, p: string) => (pastes.push(p), "")).trim();
  return { text, pastes };
}
/** How often a thread is read again while an answer is being made, in case the live signal does not get through. */
export const CHAT_POLL_MS = 1_500;

/** An answer is still being made: it is waiting for the device or streaming. */
export const isBusy = (m: Pick<ChatMessageView, "state">) => m.state === "pending" || m.state === "streaming";

/** How long to wait before reading the thread again: a short while if any answer is in progress, never otherwise. */
export const chatPollInterval = (messages: ChatMessageView[] | undefined): number | false => (messages?.some(isBusy) ? CHAT_POLL_MS : false);

/** The newest tool call as a line ("Reading src/x.ts"), or null before the answer has used any. */
export function activityLine(m: Pick<ChatMessageView, "activity">): string | null {
  const last = m.activity.at(-1);
  if (!last) return null;
  const verb: Record<string, string> = { Read: "Reading", Grep: "Searching", Glob: "Finding files" };
  const v = verb[last.name] ?? last.name;
  return last.summary ? `${v} ${last.summary}` : v;
}

/** What the quiet line under an answer says, or null when it has nothing to say: the activity if there is any, else that it is waiting or writing. */
export function liveLine(m: ChatMessageView): string | null {
  if (!isBusy(m)) return null;
  return activityLine(m) ?? (m.state === "pending" ? "Waiting for your device…" : "Thinking…");
}

/** How a finished answer that did not end well is said, in plain words. Null for one that did, or is still going. */
export function endNote(m: ChatMessageView): string | null {
  if (m.state === "failed") return m.error || "The answer failed.";
  if (m.state === "canceled") return "Stopped.";
  return null;
}

/** Devices a new chat can use now, and why not when none can: the reason is shown in place of the picker. */
export function deviceAvailability(options: Pick<ChatOptions, "devices">): { online: ChatOptions["devices"]; reason: string | null } {
  if (options.devices.length === 0) return { online: [], reason: "You have no paired device. Pair a machine in Devices first." };
  const online = options.devices.filter((d) => d.status === "online" && d.models.length > 0);
  if (online.length > 0) return { online, reason: null };
  if (options.devices.some((d) => d.status === "online")) return { online: [], reason: "Your online device offers no models. Check Claude Code is installed and signed in on it." };
  return { online: [], reason: "None of your devices is online. Start the daemon on one." };
}

export type NewChatForm = { teamKey: string; repositoryId: string; deviceId: string; model: string; message: string };

/**
 * Settles what the form means from what is picked and what is on offer: a pick that is no longer on offer (the device went offline, the
 * team changed) falls back to the first that is, and `problem` says what stops it being sent, or is null when it can be.
 */
export function resolveNewChat(form: NewChatForm, options: ChatOptions | undefined): { form: NewChatForm; problem: string | null } {
  if (!options) return { form, problem: "Loading" };
  const { online, reason } = deviceAvailability(options);
  const device = online.find((d) => d.id === form.deviceId) ?? online[0];
  const repo = options.repositories.find((r) => r.id === form.repositoryId) ?? options.repositories[0];
  const model = device?.models.includes(form.model) ? form.model : (device?.models[0] ?? "");
  const resolved = { ...form, deviceId: device?.id ?? "", repositoryId: repo?.id ?? "", model };
  const text = form.message.trim();
  const problem = !repo ? "This team has no repository an agent can clone. Connect one first." : !device ? reason : !text ? "Write a message" : text.length > MAX_MESSAGE ? `Keep it under ${MAX_MESSAGE} characters` : null;
  return { form: resolved, problem };
}

/** Within a few pixels of the end counts as being at the bottom: new text then keeps the view following it. */
export const atBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;
