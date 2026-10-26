import { z } from "zod";
import { anything } from "../../../common/pipes/lenient";

/** `{ code, name? }`: approve a machine as the caller's own. */
export const approveDeviceDto = z.object({ code: anything, name: anything });
export type ApproveDeviceDto = z.infer<typeof approveDeviceDto>;

/** `{ code }`: this is not my machine. */
export const denyDeviceDto = z.object({ code: anything });
export type DenyDeviceDto = z.infer<typeof denyDeviceDto>;
