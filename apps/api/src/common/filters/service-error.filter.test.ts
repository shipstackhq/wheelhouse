import { describe, test } from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import type { ArgumentsHost } from "@nestjs/common";
import { ServiceError } from "../service-error";
import { AppExceptionFilter } from "./app-exception.filter";
import { ServiceErrorFilter } from "./service-error.filter";

/** A fake Express response that records what the filter sent. */
function run(filter: { catch(e: unknown, host: ArgumentsHost): void }, error: unknown) {
  const sent = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const res = {
    status(s: number) {
      sent.status = s;
      return res;
    },
    set(h: Record<string, string>) {
      Object.assign(sent.headers, h);
      return res;
    },
    json(b: unknown) {
      sent.body = JSON.parse(JSON.stringify(b));
      return res;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  filter.catch(error, host);
  return sent;
}

describe("ServiceErrorFilter", () => {
  const cases: [string, ServiceError][] = [
    ["not_found", new ServiceError("not_found", "Team WH not found")],
    ["conflict", new ServiceError("conflict", "Changed by someone else", { current: { version: 3 } })],
    ["invalid with fields", new ServiceError("invalid", "Enter a name", { fields: { name: "Enter a name" } })],
    ["forbidden", new ServiceError("forbidden", "Your role on this team is read only")],
  ];

  for (const [name, error] of cases) {
    test(`${name} is answered exactly as the app answers it today`, () => {
      const today = run(new AppExceptionFilter(), error);
      const filtered = run(new ServiceErrorFilter(), error);
      assert.deepEqual(filtered, today);
      assert.equal(filtered.status, error.status);
    });
  }

  test("it is registered for ServiceError only, so other exceptions keep their own answer", () => {
    assert.deepEqual(Reflect.getMetadata("__filterCatchExceptions__", ServiceErrorFilter), [ServiceError]);
  });
});
