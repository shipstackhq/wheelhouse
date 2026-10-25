import { z } from "zod";
import { anything } from "../../../common/pipes/lenient";

/** `{ body }`: a comment in Markdown; the handler checks it is a string. */
export const commentDto = z.object({ body: anything });
export type CommentDto = z.infer<typeof commentDto>;
