import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { pingDb } from "../../db";

@Controller()
export class HealthController {
  /** Liveness + database check for the compose healthcheck and the deploy gate. No auth, no data. */
  @Get("api/health")
  async health(@Res() res: Response) {
    try {
      await pingDb();
      res.json({ ok: true });
    } catch (err) {
      console.error("health check failed", err);
      res.status(503).json({ ok: false });
    }
  }
}
