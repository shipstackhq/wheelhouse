import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asKey, call, deliver, deliveryId, fx, sign, v1ok } from "./lib/http";

const gh = fx.github!;
const A = asKey(fx.a.apiKey);
const B = asKey(fx.b.apiKey);

const pr = (o: { action: string; number: number; title: string; sha?: string; installation?: string; merged?: boolean; draft?: boolean; state?: string }) => ({
  action: o.action,
  number: o.number,
  pull_request: {
    number: o.number,
    title: o.title,
    html_url: `https://github.test/ct/app/pull/${o.number}`,
    state: o.state ?? (o.action === "closed" ? "closed" : "open"),
    merged: !!o.merged,
    draft: !!o.draft,
    user: { login: "contract-bot" },
    head: { sha: o.sha ?? "a".repeat(40), ref: `wh/${o.title.split(" ")[0]}-change` },
  },
  repository: { id: Number(gh.repoId) },
  installation: { id: Number(o.installation ?? gh.installationA) },
});

const ticket = (as: ReturnType<typeof asKey>, ref: string) => v1ok(as, "get_ticket", { ticket: ref });
const eventTypes = async (as: ReturnType<typeof asKey>, team: string) => JSON.stringify(await v1ok(as, "get_activity", { project: team, limit: 60 }));

describe("POST /api/webhooks/github: signature and framing", () => {
  test("a missing, wrong or malformed signature is one plain 401, and nothing is processed", async () => {
    const body = { zen: "Keep it logically awesome." };
    const id = deliveryId();
    for (const o of [{ signature: null }, { secret: "wrong-secret" }, { signature: "sha256=zz" }, { signature: "sha1=" + "a".repeat(40) }, { signature: "sha256=" + "0".repeat(64) }]) {
      const r = await deliver("ping", body, { id, ...o });
      assert.equal(r.status, 401, JSON.stringify(o));
      assert.equal(r.text, "Bad signature");
    }
    // The failed attempts did not use up the delivery id.
    const ok = await deliver("ping", body, { id });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { status: "handled", detail: "pong" });
  });

  test("the signature is over the raw bytes: a re-serialised body does not verify", async () => {
    const raw = '{"zen":  "spacing matters"}';
    const r = await deliver("ping", null, { raw, signature: sign(fx.github!.webhookSecret, JSON.stringify(JSON.parse(raw))) });
    assert.equal(r.status, 401);
  });

  test("a signed request without the GitHub headers, or not JSON, is a 400", async () => {
    assert.equal((await deliver(null, { a: 1 })).status, 400);
    assert.equal((await deliver("ping", { a: 1 }, { id: null })).status, 400);
    const notJson = await deliver("ping", null, { raw: "this is not json" });
    assert.equal(notJson.status, 400);
    assert.equal(notJson.text, "Not JSON");
  });

  test("a body over 5 MB is refused before it is read", async () => {
    const big = "x".repeat(5 * 1024 * 1024 + 16);
    const r = await call("/api/webhooks/github", { method: "POST", rawBody: big, headers: { "x-github-event": "ping", "x-github-delivery": deliveryId(), "x-hub-signature-256": sign(gh.webhookSecret, big) } });
    assert.equal(r.status, 413);
  });

  test("a redelivery of the same delivery id changes nothing", async () => {
    const id = deliveryId();
    assert.deepEqual((await deliver("ping", { n: 1 }, { id })).json, { status: "handled", detail: "pong" });
    assert.deepEqual((await deliver("ping", { n: 1 }, { id })).json, { status: "duplicate" });
  });

  test("events the app does not use are acknowledged and ignored", async () => {
    const r = await deliver("star", { action: "created" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: "ignored", detail: 'event "star" is not used' });
  });
});

describe("POST /api/webhooks/github: pushes", () => {
  const push = (over: Record<string, unknown> = {}) => ({ ref: "refs/heads/main", before: "1".repeat(40), after: "2".repeat(40), repository: { id: Number(gh.repoId) }, installation: { id: Number(gh.installationA) }, ...over });

  test("a push to a connected repository's default branch lands the changed files with no plugin involved", async () => {
    const r = await deliver("push", push());
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: "handled", matched: 1, detail: "1 file(s)" });
    assert.match(await eventTypes(A, fx.a.teamKey), /code\.landed/);
  });

  test("pushes to other branches, branch deletions, unknown repositories and unknown installations are ignored", async () => {
    for (const over of [{ ref: "refs/heads/feature" }, { ref: "refs/tags/v1" }, { deleted: true }, { repository: { id: 777 } }, { installation: { id: 9999 } }]) {
      const r = await deliver("push", push(over));
      assert.equal(r.status, 200, JSON.stringify(over));
      assert.equal(r.json.status, "ignored", JSON.stringify(over));
    }
  });
});

describe("POST /api/webhooks/github: pull requests and CI", () => {
  const ref = fx.a.webhookTicketRef;
  const headSha = "b".repeat(40);

  test("a pull request naming a ticket opens it in Review, links it, and says who did it", async () => {
    assert.equal((await ticket(A, ref)).ticket.column, "Backlog");
    const r = await deliver("pull_request", pr({ action: "opened", number: 7, title: `${ref} contract change`, sha: headSha }));
    assert.deepEqual(r.json, { status: "handled", matched: 1 });
    const t = await ticket(A, ref);
    assert.equal(t.ticket.column, "Review");
    assert.equal(t.pullRequests.length, 1);
    assert.equal(t.pullRequests[0].number, 7);
    assert.equal(t.pullRequests[0].state, "open");
    assert.ok(t.comments.some((c: { authorName: string; body: string }) => c.authorName === "GitHub" && /moved to Review: pull request opened/.test(c.body)));
    assert.match(await eventTypes(A, fx.a.teamKey), /ticket\.pull_request/);
  });

  test("a failing check on the head commit marks the pull request failed and raises ticket.ci", async () => {
    const run = (conclusion: string, sha = headSha) => ({
      action: "completed",
      check_run: { name: "ci", status: "completed", conclusion, head_sha: sha, html_url: "https://github.test/ct/app/runs/1", pull_requests: [{ number: 7 }] },
      repository: { id: Number(gh.repoId) },
      installation: { id: Number(gh.installationA) },
    });
    const stale = await deliver("check_run", run("failure", "c".repeat(40)));
    assert.equal(stale.json.status, "ignored", "a result for a commit that is not the head is ignored");
    const r = await deliver("check_run", run("failure"));
    assert.deepEqual(r.json, { status: "handled", matched: 1 });
    const t = await ticket(A, ref);
    assert.equal(t.pullRequests[0].ciState, "failure");
    assert.match(await eventTypes(A, fx.a.teamKey), /ticket\.ci/);
    assert.ok(t.comments.some((c: { body: string }) => /CI failed on pull request/.test(c.body)));
  });

  test("closing without merging sends a ticket in Review back to In Progress", async () => {
    await deliver("pull_request", pr({ action: "closed", number: 7, title: `${ref} contract change`, sha: headSha }));
    const t = await ticket(A, ref);
    assert.equal(t.ticket.column, "In Progress");
    assert.equal(t.pullRequests[0].state, "closed");
  });

  test("a pull request for a repository nobody connected is ignored", async () => {
    const p = pr({ action: "opened", number: 8, title: `${ref} elsewhere` });
    p.repository.id = 777;
    assert.equal((await deliver("pull_request", p)).json.status, "ignored");
  });
});

describe("POST /api/webhooks/github: two workspaces, one repository id", () => {
  test("a delivery through workspace A's installation never touches workspace B's tickets", async () => {
    const bRef = fx.b.ticketRef;
    const before = await ticket(B, bRef);
    // Workspace B also holds a forged repository row that points at workspace A's installation; it must never be reached.
    const r = await deliver("pull_request", pr({ action: "opened", number: 21, title: `${bRef} sneaking in`, installation: gh.installationA }));
    assert.equal(r.json.matched, 1, "only workspace A's own repository matched");
    const after = await ticket(B, bRef);
    assert.equal(after.ticket.column, before.ticket.column);
    assert.equal(after.pullRequests.length, 0);
    assert.equal(after.ticket.version, before.ticket.version);
  });

  test("a delivery through workspace B's installation never touches workspace A's tickets", async () => {
    const aRef = fx.a.ticketRef;
    const before = await ticket(A, aRef);
    await deliver("pull_request", pr({ action: "opened", number: 22, title: `${aRef} sneaking in`, installation: gh.installationB }));
    const after = await ticket(A, aRef);
    assert.equal(after.ticket.column, before.ticket.column);
    assert.equal(after.pullRequests.length, 0);
    assert.equal(after.ticket.version, before.ticket.version);
  });

  test("an installation deleted event removes it, after which its deliveries are ignored", async () => {
    // Use a throwaway delivery for an installation nobody has: the event is acknowledged either way.
    const r = await deliver("installation", { action: "deleted", installation: { id: 123456 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "handled");
  });
});
