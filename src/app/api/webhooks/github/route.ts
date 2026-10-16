import { receiveWebhook } from "@wheelhouse/core/lib/github/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GitHub's webhook (WH-20). All of the rules (signature over the raw body, size, framing, dispatch) are in @wheelhouse/core. */
export async function POST(request: Request) {
  const r = await receiveWebhook({
    declaredLength: Number(request.headers.get("content-length") ?? 0),
    readBody: () => request.text(),
    signature: request.headers.get("x-hub-signature-256"),
    event: request.headers.get("x-github-event"),
    deliveryId: request.headers.get("x-github-delivery"),
  });
  return r.json !== undefined ? Response.json(r.json) : new Response(r.text, { status: r.status });
}
