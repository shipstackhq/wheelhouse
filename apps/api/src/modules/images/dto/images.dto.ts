import { z } from "zod";
import { anything } from "../../../common/pipes/lenient";

/** `{ data }`: the picture, base64. The service checks it. */
export const imageDto = z.object({ data: anything });
export type ImageDto = z.infer<typeof imageDto>;
