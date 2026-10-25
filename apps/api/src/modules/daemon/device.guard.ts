import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { Device } from "./device-common";
import { DeviceAuthService } from "./device-auth.service";
import type { RawTextRequest } from "../../common/http/raw-text";

export type DeviceRequest = Request & RawTextRequest & { device: Device };

/** A paired machine: `Authorization: Bearer whd_...`, the short-lived token it exchanged its signed assertion for. No cookies, so no CSRF. */
@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(@Inject(DeviceAuthService) private readonly auth: DeviceAuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<DeviceRequest>();
    req.device = await this.auth.deviceForToken(req.headers.authorization ?? null);
    return true;
  }
}
