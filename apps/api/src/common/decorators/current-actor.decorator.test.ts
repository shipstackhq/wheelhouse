import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../actor";
import { actorOf } from "./current-actor.decorator";

const person: Actor = { kind: "human", id: "u1", name: "Ada", workspaceId: "w1" };
const key: Actor = { kind: "agent", id: "k1", name: "Claude", workspaceId: "w1" };

describe("CurrentActor", () => {
  test("an API key or session request (ActorGuard) gives req.actor", () => {
    assert.equal(actorOf({ actor: key }), key);
    assert.equal(actorOf({ actor: person }), person);
  });

  test("a signed-in person on an /api/app route (SessionGuard, HumanGuard) gives req.human.actor", () => {
    assert.equal(actorOf({ human: { actor: person } }), person);
  });

  test("a request no guard has touched gives nothing", () => {
    assert.equal(actorOf({}), undefined);
  });
});
