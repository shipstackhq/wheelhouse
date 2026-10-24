import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { ExecutionContext } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { JsonBody } from "./json-body.decorator";
import { ZodValidationPipe } from "../pipes/zod-validation.pipe";
import { anything, text, textOrNull } from "../pipes/lenient";

// What the decorator hands the pipe: the factory Nest stored for the parameter, called with a request.
function bodyOf(rawText: string | undefined) {
  class C {
    m(@JsonBody() b: unknown) {
      void b;
    }
  }
  const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, C, "m") as Record<string, { factory: (d: unknown, ctx: ExecutionContext) => unknown }>;
  const { factory } = Object.values(meta)[0];
  return factory(undefined, { switchToHttp: () => ({ getRequest: () => ({ rawText }) }) } as unknown as ExecutionContext);
}

describe("@JsonBody", () => {
  test("hands over the parsed JSON object", () => {
    assert.deepEqual(bodyOf('{"a":1}'), { a: 1 });
  });
  test("a missing body is an empty object", () => {
    assert.deepEqual(bodyOf(undefined), {});
    assert.deepEqual(bodyOf("  "), {});
  });
  test("a body that is not a JSON object is the usual 400", () => {
    assert.throws(() => bodyOf("nope"), { code: "invalid", message: "The request body must be JSON" });
    assert.throws(() => bodyOf("[1]"), { code: "invalid", message: "The request body must be a JSON object" });
  });
});

describe("the lenient DTO fields", () => {
  const dto = z.object({ name: text, parent: textOrNull });
  const pipe = new ZodValidationPipe(dto);
  test("shape fields the way the controllers always did, and never reject", () => {
    assert.deepEqual(pipe.transform({ name: 7, parent: "" }), { name: "", parent: null });
    assert.deepEqual(pipe.transform({ name: "x", parent: "Y" }), { name: "x", parent: "Y" });
    assert.deepEqual(pipe.transform({}), { name: "", parent: null });
  });
  test("a pass-through field may be missing (Zod 4 would reject a plain unknown)", () => {
    const p = new ZodValidationPipe(z.object({ role: anything, name: text }));
    assert.deepEqual(p.transform({}), { name: "" });
    assert.deepEqual(p.transform({ role: null, name: "x" }), { role: null, name: "x" });
  });
});
