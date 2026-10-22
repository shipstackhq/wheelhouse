import { ApiError } from "@wheelhouse/api-client";

/** What a form shows after it was submitted: an error, a success note, and (once) a secret to copy. */
export type FormState = { error?: string; ok?: string; secret?: string } | undefined;

/**
 * A failed call as the form should show it. The server's message is written for people (and is the same text the Next app showed),
 * and a dropped connection says so. Anything else is a bug and goes to the error page.
 */
export function failure(e: unknown): FormState {
  return { error: describeFailure(e) };
}

/** The same, as a plain message, for places that are not a form (the board, the issue dialog). Anything unexpected is rethrown. */
export function describeFailure(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return "Cannot reach Wheelhouse. Check your connection and try again.";
  throw e;
}

/** The text of one named field of a submitted form. */
export const field = (fd: FormData, name: string) => String(fd.get(name) ?? "");
