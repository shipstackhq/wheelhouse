import type { PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { ServiceError } from "../service-error";

/**
 * Checks a request value against a Zod schema and returns the parsed value. A failure is a ServiceError("invalid") with
 * `details.fields` = `{ field: message }`, the same shape the app already sends for field problems, so the error filter
 * renders it without a special case. A field is the dotted path of the problem ("body" when the whole value is wrong).
 * Built per route, as `@Body(new ZodValidationPipe(schema))`: it is not injectable, because the schema is the argument.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const field = issue.path.length ? issue.path.map(String).join(".") : "body";
      fields[field] ??= issue.message;
    }
    throw new ServiceError("invalid", result.error.issues[0]?.message ?? "Invalid request", { fields });
  }
}
