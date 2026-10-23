import { githubConfig } from "./config";
import { verifySignature } from "./signature";
import { github } from "./runtime";
import { handleDelivery } from "./service";

export const MAX_WEBHOOK_BODY = 5 * 1024 * 1024; // GitHub's own limit is 25 MB; nothing we use comes close to this

/** What a host sends back. `json` is sent as JSON, `text` as plain text. */
export type WebhookReply = { status: number; text?: string; json?: unknown };

/**
 * GitHub's webhook (WH-20). The signature is checked against the raw body before anything is parsed or looked up, and a
 * failure is one plain 401. What a delivery may touch is decided in handleDelivery: only repositories that a workspace's own,
 * verified installation has connected. The host reads the body (`readBody`) so the bytes are exactly what GitHub signed.
 */
export async function receiveWebhook(i: {
  declaredLength: number;
  readBody: () => Promise<string>;
  signature: string | null;
  event: string | null;
  deliveryId: string | null;
}): Promise<WebhookReply> {
  const cfg = githubConfig();
  if (!cfg) return { status: 503, text: "The GitHub App is not configured on this server" };

  if (i.declaredLength > MAX_WEBHOOK_BODY) return { status: 413, text: "Too large" };
  const raw = await i.readBody();
  if (raw.length > MAX_WEBHOOK_BODY) return { status: 413, text: "Too large" };

  if (!verifySignature(cfg.webhookSecret, raw, i.signature)) return { status: 401, text: "Bad signature" };

  if (!i.event || !i.deliveryId) return { status: 400, text: "Missing GitHub headers" };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, text: "Not JSON" };
  }

  try {
    return { status: 200, json: await handleDelivery({ event: i.event, deliveryId: i.deliveryId, payload }, github()?.api ?? null) };
  } catch (e) {
    console.error(`[github] ${i.event} ${i.deliveryId} failed:`, e instanceof Error ? e.message : e);
    return { status: 500, text: "Could not process this delivery; it can be redelivered" };
  }
}
