import { z } from "zod";
import { text } from "../../../common/pipes/lenient";

/** `{ action }`: publish or discard a draft; the handler checks the value. */
export const resolveDraftDto = z.object({ action: text });
export type ResolveDraftDto = z.infer<typeof resolveDraftDto>;
