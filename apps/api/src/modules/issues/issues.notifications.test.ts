/**
 * What an issue tells people, against a real database: assigned, commented, ready for review. For each, who is told (a person, never the
 * one who did it), that a repeat is not a second item and a later change is, and that a notification that fails does not fail the
 * change. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import crypto from "node:crypto";
import { before, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { createTeam } from "../teams/teams.legacy";
import { NotificationsService } from "../notifications/index";
import { addComment, createIssue, moveIssue, updateIssue } from "./issues.legacy";
import { IssueNotifications } from "./issues.notifications";
import { testApp } from "../../test/app";
const app = await testApp();
const inbox = app.get(NotificationsService);
const notices = app.get(IssueNotifications, { strict: false });

const RUN = crypto.randomBytes(3).toString("hex");
let owner: Actor; // creates the issues
let bob: Actor; // assignee
let carol: Actor; // a third teammate
let workspaceId: string;
let teamId: string;

async function person(name: string, role: "owner" | "member"): Promise<Actor> {
  const db = await getDb();
  const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}@example.com`, name, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role });
  return { kind: "human", id: u.id, name, workspaceId };
}

before(async () => {
  const db = await getDb();
  const [ws] = await db.insert(schema.workspaces).values({ name: `issue notices ${RUN}` }).returning();
  workspaceId = ws.id;
  owner = await person("olive", "owner");
  bob = await person("bob", "member");
  carol = await person("carol", "member");
  const team = await createTeam(owner, { name: "Notices", key: "NT" });
  teamId = team.id;
  for (const p of [bob, carol]) await db.insert(schema.teamMembers).values({ teamId, userId: p.id, workspaceId, role: "editor" });
});

/** The person's inbox items about one issue, oldest first. */
const mine = async (who: Actor, issueId: string) =>
  (await inbox.list({ userId: who.id, workspaceId }, { limit: 100 })).items.filter((i) => i.subjectId === issueId).reverse();
const types = async (who: Actor, issueId: string) => (await mine(who, issueId)).map((i) => i.type);

/** Runs `fn` with the inbox failing every insert, and says how many times it was asked. */
async function withBrokenInbox(fn: () => Promise<unknown>) {
  const broken = mock.method(inbox, "notify", async () => {
    throw new Error("inbox is down");
  });
  try {
    await fn();
    return broken.mock.callCount();
  } finally {
    broken.mock.restore();
  }
}

describe("assigned", () => {
  test("the new assignee is told, with the issue's title and a link to it; the person who assigned is not", async () => {
    const issue = await createIssue(owner, "NT", { title: "Fix login" });
    await updateIssue(owner, issue.ref, { assigneeId: bob.id });
    const [item, ...rest] = await mine(bob, issue.id);
    assert.equal(rest.length, 0);
    assert.equal(item.type, "issue.assigned");
    assert.equal(item.title, `${issue.ref} assigned to you`);
    assert.equal(item.body, "Fix login");
    assert.equal(item.href, `/t/NT?t=${issue.ref}`);
    assert.equal(item.source, "wheelhouse");
    assert.equal(item.teamId, teamId);
    assert.equal(item.subjectEntity, "issue");
    assert.equal(item.actorKind, "human");
    assert.equal(item.actorId, owner.id);
    assert.equal(item.actorName, "olive");
    assert.deepEqual(await mine(owner, issue.id), []);
  });

  test("an issue created with an assignee tells them; assigning yourself tells nobody", async () => {
    const made = await createIssue(owner, "NT", { title: "born assigned", assigneeId: carol.id });
    assert.deepEqual(await types(carol, made.id), ["issue.assigned"]);
    const mineAlready = await createIssue(bob, "NT", { title: "mine", assigneeId: bob.id });
    assert.deepEqual(await mine(bob, mineAlready.id), []);
    const later = await createIssue(owner, "NT", { title: "self later" });
    await updateIssue(bob, later.ref, { assigneeId: bob.id });
    assert.deepEqual(await mine(bob, later.id), []);
  });

  test("the same change is not told twice, a later change is, and an edit that leaves the assignee alone says nothing", async () => {
    const issue = await createIssue(owner, "NT", { title: "ping pong" });
    const first = await updateIssue(owner, issue.ref, { assigneeId: bob.id });
    await updateIssue(owner, issue.ref, { assigneeId: bob.id }); // nothing changed
    await updateIssue(owner, issue.ref, { title: "ping pong 2" });
    assert.deepEqual(await types(bob, issue.id), ["issue.assigned"]);
    // The same commit announced again (a retry) is one item.
    const row = { ...first, assigneeId: bob.id } as Parameters<IssueNotifications["assigned"]>[2];
    await notices.assigned(owner, { id: teamId, key: "NT", workspaceId }, row, first.ref);
    assert.deepEqual(await types(bob, issue.id), ["issue.assigned"]);
    await updateIssue(owner, issue.ref, { assigneeId: carol.id });
    await updateIssue(owner, issue.ref, { assigneeId: bob.id });
    assert.deepEqual(await types(bob, issue.id), ["issue.assigned", "issue.assigned"]);
    assert.deepEqual(await types(carol, issue.id), ["issue.assigned"]);
  });

  test("a notification that fails does not fail the change", async () => {
    const issue = await createIssue(owner, "NT", { title: "inbox down" });
    const asked = await withBrokenInbox(async () => {
      const t = await updateIssue(owner, issue.ref, { assigneeId: bob.id });
      assert.equal(t.assigneeId, bob.id);
    });
    assert.equal(asked, 1);
    assert.deepEqual(await mine(bob, issue.id), []);
    assert.equal((await updateIssue(owner, issue.ref, { title: "still works" })).title, "still works");
  });
});

describe("plain-text items", () => {
  test("an assignment item is plain text: the issue title is not read as markdown", async () => {
    const issue = await createIssue(owner, "NT", { title: "fix *the* _thing_", assigneeId: bob.id });
    const [item] = await mine(bob, issue.id);
    assert.equal(item.type, "issue.assigned");
    assert.equal(item.bodyFormat, "text");
    assert.equal(item.body, "fix *the* _thing_");
  });
});

describe("commented", () => {
  test("the creator and the assignee are told once each, not the author; the author of one is not told of their own", async () => {
    const issue = await createIssue(owner, "NT", { title: "talk", assigneeId: bob.id });
    await addComment(carol, issue.ref, "I looked at this");
    assert.deepEqual(await types(owner, issue.id), ["issue.commented"]);
    assert.deepEqual(await types(bob, issue.id), ["issue.assigned", "issue.commented"]);
    assert.deepEqual(await mine(carol, issue.id), []);
    const [item] = (await mine(owner, issue.id)).slice(-1);
    assert.equal(item.title, "carol commented on " + issue.ref);
    assert.equal(item.body, "I looked at this");
    assert.equal(item.bodyFormat, "markdown", "a comment is written in markdown, so the reader renders it");
    assert.equal(item.href, `/t/NT?t=${issue.ref}`);

    await addComment(owner, issue.ref, "thanks"); // the creator comments: only the assignee hears
    assert.equal((await mine(owner, issue.id)).length, 1);
    assert.equal((await types(bob, issue.id)).filter((t) => t === "issue.commented").length, 2);
  });

  test("a long comment is cut at a paragraph or a word, never mid-word, and says it was cut; a short one is kept whole", async () => {
    const issue = await createIssue(owner, "NT", { title: "long talk", assigneeId: bob.id });
    const long = `${"A paragraph of **bold** words and \`code\`. ".repeat(20).trim()}\n\n${"more words here ".repeat(120)}`;
    await addComment(carol, issue.ref, long);
    const [cut] = (await mine(owner, issue.id)).slice(-1);
    assert.ok(cut.body.length <= 1001, "at most the limit plus the ellipsis");
    assert.ok(cut.body.endsWith("…"));
    assert.ok(long.startsWith(cut.body.slice(0, -1)), "a true prefix of the comment");
    assert.ok(/\s/.test(long[cut.body.length - 1]), "the cut falls on whitespace, not inside a word");
    await addComment(carol, issue.ref, "short and **sweet**");
    assert.equal((await mine(owner, issue.id)).slice(-1)[0].body, "short and **sweet**");
  });

  test("one person who is both creator and assignee gets one item per comment, and every comment is a new item", async () => {
    const issue = await createIssue(owner, "NT", { title: "mine and mine", assigneeId: owner.id });
    await addComment(bob, issue.ref, "one");
    await addComment(bob, issue.ref, "two");
    assert.deepEqual(await types(owner, issue.id), ["issue.commented", "issue.commented"]);
  });

  test("an issue made by an agent, or by someone who has left the team, is not told; a repeat of the same comment is one item", async () => {
    const issue = await createIssue(owner, "NT", { title: "orphan", assigneeId: bob.id });
    const team = { id: teamId, key: "NT", workspaceId };
    const row = (extra: object) => ({ ...issue, ...extra }) as Parameters<IssueNotifications["commented"]>[2];
    await notices.commented(carol, team, row({ createdByKind: "agent", createdById: owner.id }), issue.ref, { id: crypto.randomUUID(), body: "x" });
    assert.deepEqual(await mine(owner, issue.id), [], "an agent's key id is not a person to tell");
    const stranger = await person("stranger", "member"); // in the workspace, not on the team
    await notices.commented(carol, team, row({ createdByKind: "human", createdById: stranger.id }), issue.ref, { id: crypto.randomUUID(), body: "x" });
    assert.deepEqual(await mine(stranger, issue.id), []);
    const same = { id: crypto.randomUUID(), body: "again" };
    await notices.commented(carol, team, row({}), issue.ref, same);
    await notices.commented(carol, team, row({}), issue.ref, same);
    assert.equal((await types(bob, issue.id)).filter((t) => t === "issue.commented").length, 3, "two from above, one from this comment");
  });

  test("a notification that fails does not fail the comment", async () => {
    const issue = await createIssue(owner, "NT", { title: "comment, inbox down", assigneeId: bob.id });
    const asked = await withBrokenInbox(async () => {
      const c = await addComment(carol, issue.ref, "still saved");
      assert.equal(c.body, "still saved");
    });
    assert.equal(asked, 2, "the creator and the assignee were each tried");
  });
});

describe("moved to review", () => {
  test("the creator and the assignee are told, not the person who moved it", async () => {
    const issue = await createIssue(owner, "NT", { title: "ship it", assigneeId: bob.id });
    await moveIssue(carol, issue.ref, "review");
    assert.deepEqual((await types(owner, issue.id)), ["issue.review"]);
    assert.deepEqual((await types(bob, issue.id)), ["issue.assigned", "issue.review"]);
    assert.deepEqual(await mine(carol, issue.id), []);
    const [item] = (await mine(owner, issue.id)).slice(-1);
    assert.equal(item.title, `${issue.ref} is ready for review`);
    assert.equal(item.body, "ship it");
    assert.equal(item.href, `/t/NT?t=${issue.ref}`);
  });

  test("the assignee moving it tells only the creator; another status, or the same one again, tells nobody; going back to review later does", async () => {
    const issue = await createIssue(owner, "NT", { title: "round trip", assigneeId: bob.id });
    await moveIssue(bob, issue.ref, "review");
    assert.deepEqual(await types(owner, issue.id), ["issue.review"]);
    assert.deepEqual(await types(bob, issue.id), ["issue.assigned"]);
    await moveIssue(bob, issue.ref, "review"); // already there
    await moveIssue(owner, issue.ref, "In Progress");
    assert.deepEqual(await types(owner, issue.id), ["issue.review"], "the actor is not told of their own move either");
    assert.deepEqual(await types(bob, issue.id), ["issue.assigned"], "In Progress is not review");
    await moveIssue(carol, issue.ref, "review");
    assert.deepEqual(await types(owner, issue.id), ["issue.review", "issue.review"]);
    assert.deepEqual(await types(bob, issue.id), ["issue.assigned", "issue.review"]);
  });

  test("a notification that fails does not fail the move", async () => {
    const issue = await createIssue(owner, "NT", { title: "move, inbox down", assigneeId: bob.id });
    const asked = await withBrokenInbox(async () => {
      const t = await moveIssue(carol, issue.ref, "review");
      assert.equal(t.status, "Review");
    });
    assert.equal(asked, 2);
  });
});
