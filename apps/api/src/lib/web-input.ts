import { AccountError } from "../modules/auth/auth-errors";
import { ServiceError } from "../common/service-error";
import { minutes } from "../common/rate-limit";

/**
 * Reading a JSON request body for the web app's endpoints: a wrong type is a 400 whose `details.fields` names the field, and
 * nothing wrong-typed reaches the database. The same checks the MCP tools make (a string, a known value, a list of strings).
 */

export const bad = (field: string, message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

type Body = Record<string, unknown>;

/** Text, or undefined when absent. `max` caps its length. */
export function text(b: Body, name: string, o: { required?: boolean; max?: number; trim?: boolean } = {}): string | undefined {
  const v = b[name];
  if (v === undefined) return o.required ? bad(name, `${name} is required`) : undefined;
  if (typeof v !== "string") return bad(name, `${name} must be text`);
  const s = o.trim ? v.trim() : v;
  if (o.required && !s.trim()) return bad(name, `${name} is required`);
  if (o.max !== undefined && s.length > o.max) return bad(name, `${name} is too long (at most ${o.max} characters)`);
  return s;
}

/** Text or null (null clears), or undefined when absent. */
export function textOrNull(b: Body, name: string): string | null | undefined {
  const v = b[name];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return bad(name, `${name} must be text, or null`);
  return v || null;
}

export function oneOf<T extends string>(b: Body, name: string, allowed: readonly T[], required = false): T | undefined {
  const v = b[name];
  if (v === undefined) return required ? bad(name, `${name} is required`) : undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) return bad(name, `${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

export function textList(b: Body, name: string, max = 200): string[] | undefined {
  const v = b[name];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return bad(name, `${name} must be a list of text`);
  if (v.length > max) return bad(name, `${name} has too many entries (at most ${max})`);
  return v as string[];
}

export function whole(b: Body, name: string): number | undefined {
  const v = b[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return bad(name, `${name} must be a whole number`);
  return v;
}

export function finite(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return bad(field, `${field} must be a number`);
  return v;
}

/** A rate limit hit, in the app's error envelope (429 with Retry-After). */
export const rateLimited = (retryAfter: number) =>
  new AccountError("rate_limited", `Too many attempts. Try again in ${minutes(retryAfter)} minute${minutes(retryAfter) === 1 ? "" : "s"}.`, { retryAfter });
