import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { destructive, outOfOrder } from "../scripts/check-migrations";

describe("the migration gate", () => {
  test("a migration not newer than the one before it is reported, since Drizzle would skip it", () => {
    assert.deepEqual(outOfOrder([{ tag: "a", when: 1 }, { tag: "b", when: 3 }, { tag: "c", when: 2 }, { tag: "d", when: 4 }]), ["c is not newer than b"]);
    assert.deepEqual(outOfOrder([{ tag: "a", when: 1 }, { tag: "b", when: 1 }]), ["b is not newer than a"]);
    assert.deepEqual(outOfOrder([{ tag: "a", when: 1 }, { tag: "b", when: 2 }]), []);
  });

  const rows: [string, string, string[]][] = [
    ["a new table", `CREATE TABLE "x" ("id" uuid PRIMARY KEY NOT NULL);`, []],
    ["a nullable column", `ALTER TABLE "x" ADD COLUMN "y" jsonb;`, []],
    ["a required column with a default", `ALTER TABLE "x" ADD COLUMN "y" jsonb DEFAULT '[]'::jsonb NOT NULL;`, []],
    ["an index and a foreign key", `CREATE INDEX "i" ON "x" USING btree ("y");--> statement-breakpoint\nALTER TABLE "x" ADD CONSTRAINT "f" FOREIGN KEY ("y") REFERENCES "public"."z"("id");`, []],
    ["a scoped data update", `UPDATE "x" SET "y" = '[]' WHERE "z" = 'a';`, []],
    ["a required column with no default", `ALTER TABLE "x" ADD COLUMN "y" text NOT NULL;`, ["adds a required column with no default"]],
    ["a dropped column", `ALTER TABLE "x" DROP COLUMN "y";`, ["drops something"]],
    ["a dropped table", `DROP TABLE "x" CASCADE;`, ["drops something"]],
    ["a renamed column", `ALTER TABLE "x" RENAME COLUMN "y" TO "z";`, ["renames something"]],
    ["a type change", `ALTER TABLE "x" ALTER COLUMN "y" SET DATA TYPE integer;`, ["changes a column's type"]],
    ["a column made required", `ALTER TABLE "x" ALTER COLUMN "y" SET NOT NULL;`, ["makes a column required"]],
    ["emptied and deleted rows", `TRUNCATE "x";--> statement-breakpoint\nDELETE FROM "y" WHERE true;`, ["empties a table", "deletes rows"]],
    ["a word only in a comment", `-- we used to DROP TABLE here\nCREATE TABLE "x" ("id" uuid);`, []],
    ["destructive, with a reason", `-- destructive: the column was never read\nALTER TABLE "x" DROP COLUMN "y";`, []],
  ];
  for (const [name, sql, why] of rows) test(name, () => assert.deepEqual(destructive(sql), why));
});
