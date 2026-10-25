import { ServiceError } from "./service-error";
import type { RawTextRequest } from "./http/raw-text";

/** A JSON object as it came: its fields are not known to the route, and the function it is passed to judges them. */
export type JsonObject = Record<string, unknown>;

/** The JSON object in a request body. A missing, unparseable or non-object body is a 400 in the usual envelope. */
export function jsonBody(req: RawTextRequest): JsonObject {
  const raw = req.rawText ?? "";
  if (!raw.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ServiceError("invalid", "The request body must be JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ServiceError("invalid", "The request body must be a JSON object");
  return v as Record<string, unknown>;
}

export const str = (v: unknown) => (typeof v === "string" ? v : "");
