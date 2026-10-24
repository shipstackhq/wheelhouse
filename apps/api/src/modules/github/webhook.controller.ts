import { Controller, Inject, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import type { RawTextRequest } from "../../common/http/raw-text";
import { DeliveriesService } from "./deliveries.service";

@Controller("api/webhooks/github")
export class WebhookController {
  constructor(@Inject(DeliveriesService) private readonly deliveries: DeliveriesService) {}

  /**
   * GitHub's webhook (WH-20). The signature is over the raw bytes, which the raw-text middleware keeps exactly as received;
   * every rule (signature, size, framing, dispatch) is the github module's.
   */
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawTextRequest, @Res() res: Response) {
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    };
    const r = await this.deliveries.receiveWebhook({
      declaredLength: Number(header("content-length") ?? 0),
      readBody: async () => req.rawText ?? "",
      signature: header("x-hub-signature-256"),
      event: header("x-github-event"),
      deliveryId: header("x-github-delivery"),
    });
    if (r.json !== undefined) res.status(r.status).json(r.json);
    else res.status(r.status).type("text/plain").send(r.text);
  }
}
