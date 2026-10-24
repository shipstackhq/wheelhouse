import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { deviceForToken, type Device } from "./internal";
import type { RawTextRequest } from "../../http/raw-text";

export type DeviceRequest = Request & RawTextRequest & { device: Device };

/** A paired machine: `Authorization: Bearer whd_...`, the short-lived token it exchanged its signed assertion for. No cookies, so no CSRF. */
@Injectable()
export class DeviceGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<DeviceRequest>();
    req.device = await deviceForToken(req.headers.authorization ?? null);
    return true;
  }
}
