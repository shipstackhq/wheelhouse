import { z } from "zod";

/**
 * Building blocks for DTOs on routes that already accept anything and leave the judging to the service (so today's error messages
 * stay): they shape a field the way the controllers always did, and never reject.
 */

/** A string field: anything that is not a string is "" (what `str()` always did). */
export const text = z.unknown().optional().transform((v) => (typeof v === "string" ? v : ""));

/** A string field where "" and a missing value mean "not given". */
export const textOrUndefined = z.unknown().optional().transform((v) => (typeof v === "string" && v ? v : undefined));

/** A string field where "" and a missing value mean null. */
export const textOrNull = z.unknown().optional().transform((v) => (typeof v === "string" && v ? v : null));

/** A string that is kept when it is one and is undefined otherwise (a partial update). */
export const stringOrUndefined = z.unknown().optional().transform((v) => (typeof v === "string" ? v : undefined));

/** A field passed to the service as it came, judged there. Optional: in Zod 4 a plain `z.unknown()` rejects a missing key, which would change today's answer. */
export const anything = z.unknown().optional();
