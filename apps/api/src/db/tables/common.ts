import { pgTable, timestamp, check, type PgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * `pgTable`, plus a CHECK constraint for every column declared with an `enum`: the TypeScript values are the source of
 * truth and the database refuses anything else (WH-114). The constraint is named `<table>_<column>_check`; a test compares
 * each one in the database with its enum.
 */
export const table = ((name: string, columns: Record<string, unknown>, extra?: (t: never) => unknown[]) =>
  pgTable(name, columns as never, (t) => {
    // The columns handed to this callback are wrappers: the enum is on their `config`.
    const enumOf = (c: PgColumn) => ((c as unknown as { config?: { enumValues?: string[] } }).config?.enumValues ?? c.enumValues) as string[] | undefined;
    const checks = (Object.values(t) as PgColumn[])
      .filter((c) => (enumOf(c)?.length ?? 0) > 0)
      .map((c) => check(`${name}_${c.name}_check`, sql.raw(`"${c.name}" in (${enumOf(c)!.map((v) => `'${v}'`).join(", ")})`)));
    return [...checks, ...((extra ? extra(t as never) : []) as never[])];
  })) as unknown as typeof pgTable;

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
