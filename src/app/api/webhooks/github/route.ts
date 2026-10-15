import { githubConfig } from "@/lib/github/config";
import { verifySignature } from "@/lib/github/signature";
import { github } from "@/lib/github/runtime";
import { handleDelivery } from "@/lib/github/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 5 * 1024 * 1024; // GitHub's own limit is 25 MB; nothing we use comes close to this

/**
 * GitHub's webhook (WH-20). The signature is checked against the raw body before anything is parsed or looked up, and a
 * failure is one plain 401. What a delivery may touch is decided in handleDelivery: only repositories that a team's
 * own, verified installation has connected.
 */
export async function POST(request: Request) {
  const cfg = githubConfig();
  if (!cfg) return new Response("The GitHub App is not configured on this server", { status: 503 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) return new Response("Too large", { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response("Too large", { status: 413 });

  if (!verifySignature(cfg.webhookSecret, raw, request.headers.get("x-hub-signature-256"))) return new Response("Bad signature", { status: 401 });

  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!event || !deliveryId) return new Response("Missing GitHub headers", { status: 400 });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("Not JSON", { status: 400 });
  }

  try {
    const outcome = await handleDelivery({ event, deliveryId, payload }, github()?.api ?? null);
    return Response.json(outcome);
  } catch (e) {
    console.error(`[github] ${event} ${deliveryId} failed:`, e instanceof Error ? e.message : e);
    return new Response("Could not process this delivery; it can be redelivered", { status: 500 });
  }
}
