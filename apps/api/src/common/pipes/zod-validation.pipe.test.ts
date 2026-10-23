import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ServiceError } from "../../lib/service-error";
import { ZodValidationPipe } from "./zod-validation.pipe";

const Team = z.object({ name: z.string().min(1, "Enter a name"), size: z.number().int().optional() });

describe("ZodValidationPipe", () => {
  test("returns the parsed value for a valid body", () => {
    const pipe = new ZodValidationPipe(Team);
    assert.deepEqual(pipe.transform({ name: "Core", size: 3 }), { name: "Core", size: 3 });
  });

  test("drops keys the schema does not declare", () => {
    const pipe = new ZodValidationPipe(z.object({ name: z.string() }));
    assert.deepEqual(pipe.transform({ name: "Core", extra: true }), { name: "Core" });
  });

  test("a bad field is a ServiceError(invalid) with details.fields, the shape the app sends for field problems", () => {
    const pipe = new ZodValidationPipe(Team);
    let caught: unknown;
    try {
      pipe.transform({ name: "", size: 1.5 });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ServiceError);
    assert.equal(caught.code, "invalid");
    assert.equal(caught.status, 400);
    assert.equal(caught.message, "Enter a name");
    const fields = (caught.details as { fields: Record<string, string> }).fields;
    assert.deepEqual(Object.keys(fields).sort(), ["name", "size"]);
    assert.equal(fields.name, "Enter a name");
  });

  test("a nested field is named by its dotted path", () => {
    const pipe = new ZodValidationPipe(z.object({ team: z.object({ key: z.string().min(2, "Too short") }) }));
    assert.throws(() => pipe.transform({ team: { key: "A" } }), (e: unknown) => e instanceof ServiceError && JSON.stringify((e as ServiceError).details) === JSON.stringify({ fields: { "team.key": "Too short" } }));
  });

  test("a value of the wrong type as a whole is reported under body", () => {
    const pipe = new ZodValidationPipe(Team);
    assert.throws(() => pipe.transform("not an object"), (e: unknown) => e instanceof ServiceError && JSON.stringify((e as ServiceError).details) === JSON.stringify({ fields: { body: (e as ServiceError).message } }));
  });
});
