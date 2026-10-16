import { pingDb } from "@wheelhouse/core/db";

export const dynamic = "force-dynamic";

/** Liveness + database check for the compose healthcheck and the deploy gate. No auth, no data. */
export async function GET() {
  try {
    await pingDb();
    return Response.json({ ok: true });
  } catch (err) {
    console.error("health check failed", err);
    return Response.json({ ok: false }, { status: 503 });
  }
}
