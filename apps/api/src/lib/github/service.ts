import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../access";
import { addComment, createRepository, emit, requireTeam, moveIssue, ServiceError } from "../service";
import { land } from "../../modules/map/sync";
import { GithubApiError, isZeroSha, type ChangedFile, type GithubApi } from "./api";
import { decideMove, ciState, type CheckState } from "./pr-rules";
import { parseIssueRefs, refsForTeam } from "./refs";

const { githubDeliveries, githubInstallations, memberships, teams, pullRequests, pullRequestIssues, repositories, issues, statuses, events } = schema;

/** Writes made because of something GitHub reported are attributed to this actor, like the claim sweep's "Wheelhouse". */
export const GITHUB_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
/** It reaches only the team that owns the repository the delivery is about (WH-120). */
export const githubActor = (workspaceId: string, teamId: string): Actor => ({ kind: "human", id: GITHUB_ACTOR_ID, name: "GitHub", workspaceId, system: true, teamId });

/** Land at most this many files per call, like the baseline does. */
const LAND_CHUNK = 2000;

// ───────── connecting (owner, verified) ─────────

async function requireOwner(userId: string, workspaceId: string) {
  const db = await getDb();
  const [m] = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
  if (m?.role !== "owner") throw new ServiceError("forbidden", "Only workspace owners can connect GitHub");
}

/**
 * Record that this workspace's owner has installed the App. The caller has already proved, with GitHub's own sign-in, that this
 * person administers the installation. An installation belongs to one workspace: a second workspace cannot take it over.
 */
export async function registerInstallation(actor: Actor, i: { installationId: string; accountLogin: string; accountType: string }) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can connect GitHub");
  await requireOwner(actor.id, actor.workspaceId);
  const db = await getDb();
  const [existing] = await db.select().from(githubInstallations).where(eq(githubInstallations.installationId, i.installationId));
  if (existing && existing.workspaceId !== actor.workspaceId) throw new ServiceError("conflict", "That GitHub installation is already connected to another workspace");
  await db
    .insert(githubInstallations)
    .values({ installationId: i.installationId, workspaceId: actor.workspaceId, accountLogin: i.accountLogin, accountType: i.accountType, connectedBy: actor.id })
    .onConflictDoUpdate({ target: githubInstallations.installationId, set: { accountLogin: i.accountLogin, accountType: i.accountType } });
  return { ok: true };
}

export async function listInstallations(actor: Actor) {
  const db = await getDb();
  return db.select().from(githubInstallations).where(eq(githubInstallations.workspaceId, actor.workspaceId));
}

/**
 * Connect one repository of one of the workspace's installations to a team. The repository's name and default branch are
 * read from GitHub, not taken from the request, so what is stored is what GitHub says about a repository the installation
 * can really see.
 */
export async function connectGithubRepository(
  actor: Actor,
  teamRef: string,
  i: { installationId: string; githubRepoId: string; role: string; pathLimit?: string | null },
  api: GithubApi | null,
) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can connect repositories");
  await requireOwner(actor.id, actor.workspaceId);
  if (!api) throw new ServiceError("invalid", "The GitHub App is not configured on this server");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  // The installation must be this workspace's own: otherwise a repository id from someone else's installation would feed their pushes here.
  const [inst] = await db.select().from(githubInstallations).where(and(eq(githubInstallations.installationId, i.installationId), eq(githubInstallations.workspaceId, actor.workspaceId)));
  if (!inst) throw new ServiceError("forbidden", "That GitHub installation is not connected to your workspace");
  const visible = await api.installationRepositories(i.installationId);
  const gh = visible.find((r) => r.id === i.githubRepoId);
  if (!gh) throw new ServiceError("not_found", "GitHub does not list that repository for this installation");
  const [dup] = await db.select({ id: repositories.id }).from(repositories).where(and(eq(repositories.teamId, team.id), eq(repositories.githubRepoId, gh.id)));
  if (dup) throw new ServiceError("conflict", `${gh.fullName} is already connected to this team`);
  return createRepository(actor, teamRef, {
    displayName: gh.fullName.split("/").pop() || gh.fullName,
    role: i.role,
    provider: "github",
    githubRepoId: gh.id,
    githubInstallationId: i.installationId,
    githubFullName: gh.fullName,
    defaultBranch: gh.defaultBranch,
    pathLimit: i.pathLimit ?? null,
  });
}

// ───────── delivery handling ─────────

export type Delivery = { event: string; deliveryId: string; payload: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Outcome = { status: "handled" | "ignored" | "duplicate"; detail?: string; matched?: number };

/**
 * The repositories a webhook is about: connected through GitHub, with this exact installation and repository id, and whose
 * installation is registered to the same workspace as the team. A webhook can therefore only ever reach the workspace that
 * proved it owns the installation.
 */
export async function targetsFor(installationId: string, repoId: string) {
  const db = await getDb();
  return db
    .select({ repo: repositories, team: teams })
    .from(repositories)
    .innerJoin(teams, eq(teams.id, repositories.teamId))
    .innerJoin(githubInstallations, and(eq(githubInstallations.installationId, repositories.githubInstallationId), eq(githubInstallations.workspaceId, teams.workspaceId)))
    .where(and(eq(repositories.provider, "github"), eq(repositories.githubInstallationId, installationId), eq(repositories.githubRepoId, repoId), ne(repositories.lifecycle, "retired")));
}

export async function handleDelivery(d: Delivery, api: GithubApi | null): Promise<Outcome> {
  const db = await getDb();
  const claimed = await db.insert(githubDeliveries).values({ id: d.deliveryId, event: d.event }).onConflictDoNothing().returning({ id: githubDeliveries.id });
  if (!claimed.length) return { status: "duplicate" };
  try {
    return await dispatch(d, api);
  } catch (e) {
    await db.delete(githubDeliveries).where(eq(githubDeliveries.id, d.deliveryId)); // let GitHub's redelivery try again
    throw e;
  }
}

async function dispatch(d: Delivery, api: GithubApi | null): Promise<Outcome> {
  const installationId = d.payload.installation?.id != null ? String(d.payload.installation.id) : null;
  switch (d.event) {
    case "ping":
      return { status: "handled", detail: "pong" };
    case "installation":
      return onInstallation(d.payload, installationId);
    case "push":
      return onPush(d.payload, installationId, api);
    case "pull_request":
      return onPullRequest(d.payload, installationId);
    case "check_run":
      return onCheckRun(d.payload, installationId);
    default:
      return { status: "ignored", detail: `event "${d.event}" is not used` };
  }
}

async function onInstallation(payload: Delivery["payload"], installationId: string | null): Promise<Outcome> {
  if (!installationId) return { status: "ignored" };
  if (payload.action === "deleted") {
    const db = await getDb();
    await db.delete(githubInstallations).where(eq(githubInstallations.installationId, installationId));
    return { status: "handled", detail: "installation removed" };
  }
  return { status: "ignored", detail: `installation ${payload.action}` };
}

async function onPush(payload: Delivery["payload"], installationId: string | null, api: GithubApi | null): Promise<Outcome> {
  const repoId = payload.repository?.id != null ? String(payload.repository.id) : null;
  if (!installationId || !repoId) return { status: "ignored", detail: "no installation or repository" };
  if (payload.deleted || typeof payload.ref !== "string" || !payload.ref.startsWith("refs/heads/")) return { status: "ignored", detail: "not a branch update" };
  const branch = payload.ref.slice("refs/heads/".length);
  const targets = (await targetsFor(installationId, repoId)).filter((t) => t.repo.defaultBranch === branch);
  if (!targets.length) return { status: "ignored", detail: "not a connected repository's default branch" };
  if (!api) throw new ServiceError("invalid", "GitHub App is not configured on this server");

  const after = String(payload.after);
  const before = payload.before ? String(payload.before) : null;
  // Ask GitHub once, however many teams share the repository.
  let files: ChangedFile[];
  try {
    if (isZeroSha(before)) files = (await api.treeAt(installationId, repoId, after)).files;
    else files = await api.changedBetween(installationId, repoId, before!, after);
  } catch (e) {
    // The old commit is gone (a force push): fall back to everything at the new one; the hash comparison sorts out what really changed.
    if (e instanceof GithubApiError && (e.status === 404 || e.status === 422) && !isZeroSha(before)) files = (await api.treeAt(installationId, repoId, after)).files;
    else throw e;
  }

  const db = await getDb();
  for (const t of targets) {
    const actor = githubActor(t.team.workspaceId, t.team.id);
    for (let i = 0; i < files.length || i === 0; i += LAND_CHUNK) {
      const chunk = Object.fromEntries(files.slice(i, i + LAND_CHUNK).map((f) => [f.path, f.hash]));
      if (!Object.keys(chunk).length) break;
      await land(actor, t.team.key, { sha: after, branch, files: chunk, repository: t.repo.slug });
    }
    await db.update(repositories).set({ lastEventAt: new Date() }).where(eq(repositories.id, t.repo.id));
  }
  return { status: "handled", matched: targets.length, detail: `${files.length} file(s)` };
}

async function issuesByRefs(teamId: string, teamKey: string, refs: { key: string; number: number }[]) {
  const wanted = refsForTeam(refs, teamKey);
  if (!wanted.length) return [];
  const db = await getDb();
  const rows = await db
    .select({ t: issues, status: statuses.name })
    .from(issues)
    .innerJoin(statuses, eq(statuses.id, issues.statusId))
    .where(and(eq(issues.teamId, teamId), inArray(issues.number, wanted.map((w) => w.number))));
  return rows.map((r) => ({ ...r.t, status: r.status, ref: `${teamKey}-${r.t.number}` }));
}

async function onPullRequest(payload: Delivery["payload"], installationId: string | null): Promise<Outcome> {
  const repoId = payload.repository?.id != null ? String(payload.repository.id) : null;
  const pr = payload.pull_request;
  if (!installationId || !repoId || !pr) return { status: "ignored" };
  const targets = await targetsFor(installationId, repoId);
  if (!targets.length) return { status: "ignored", detail: "not a connected repository" };

  const db = await getDb();
  const action: string = payload.action;
  const merged = !!pr.merged;
  const state = merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  const headSha = String(pr.head?.sha ?? "");
  const headBranch = String(pr.head?.ref ?? "");

  for (const t of targets) {
    const [existing] = await db.select().from(pullRequests).where(and(eq(pullRequests.repositoryId, t.repo.id), eq(pullRequests.number, pr.number)));
    const newCommit = !!existing && existing.headSha !== headSha;
    const [row] = await db
      .insert(pullRequests)
      .values({ repositoryId: t.repo.id, number: pr.number, title: String(pr.title ?? ""), url: String(pr.html_url ?? ""), author: String(pr.user?.login ?? ""), headBranch, headSha, state, draft: !!pr.draft })
      .onConflictDoUpdate({
        target: [pullRequests.repositoryId, pullRequests.number],
        set: {
          title: String(pr.title ?? ""),
          url: String(pr.html_url ?? ""),
          headBranch,
          headSha,
          state,
          draft: !!pr.draft,
          // A new commit starts a new round of checks.
          ...(newCommit ? { checks: {}, ciState: null } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();

    const refs = parseIssueRefs(pr.title, headBranch);
    const linked = await issuesByRefs(t.team.id, t.team.key, refs);
    await db.delete(pullRequestIssues).where(eq(pullRequestIssues.pullRequestId, row.id));
    if (linked.length) await db.insert(pullRequestIssues).values(linked.map((x) => ({ pullRequestId: row.id, issueId: x.id }))).onConflictDoNothing();
    await db.update(repositories).set({ lastEventAt: new Date() }).where(eq(repositories.id, t.repo.id));

    const actor = githubActor(t.team.workspaceId, t.team.id);
    const boardStatuses = await db.select({ id: statuses.id, name: statuses.name, role: statuses.role }).from(statuses).where(eq(statuses.teamId, t.team.id)).orderBy(statuses.position);
    for (const tk of linked) {
      if (["opened", "reopened", "closed", "ready_for_review"].includes(action)) {
        await emit(db, actor, t.team.id, {
          type: "issue.pull_request",
          entity: "issue",
          entityId: tk.id,
          summary: `pull request #${pr.number} ${merged ? "merged" : action === "closed" ? "closed" : action === "ready_for_review" ? "is ready for review" : action} for ${tk.ref}: ${pr.title}`,
          data: { ref: tk.ref, number: pr.number, url: pr.html_url, state },
        });
      }
      const [last] = await db
        .select({ at: events.createdAt, by: events.actorName, actorId: events.actorId })
        .from(events)
        .where(and(eq(events.entityId, tk.id), eq(events.type, "issue.moved")))
        .orderBy(desc(events.seq))
        .limit(1);
      const current = boardStatuses.find((c) => c.id === tk.statusId);
      if (!current) continue;
      const decision = decideMove({
        action,
        merged,
        draft: !!pr.draft,
        status: current,
        statuses: boardStatuses,
        lastMove: last && last.actorId !== GITHUB_ACTOR_ID ? { at: last.at, by: last.by } : null,
        now: new Date(),
      });
      if (decision.move) await moveIssue(actor, tk.ref, decision.move);
      if (decision.note) await addComment(actor, tk.ref, `Pull request [#${pr.number}](${pr.html_url}) ${decision.note}`);
    }
  }
  return { status: "handled", matched: targets.length };
}

async function onCheckRun(payload: Delivery["payload"], installationId: string | null): Promise<Outcome> {
  const repoId = payload.repository?.id != null ? String(payload.repository.id) : null;
  const run = payload.check_run;
  if (!installationId || !repoId || !run?.name) return { status: "ignored" };
  const targets = await targetsFor(installationId, repoId);
  if (!targets.length) return { status: "ignored", detail: "not a connected repository" };

  const db = await getDb();
  const numbers: number[] = (run.pull_requests ?? []).map((p: { number: number }) => p.number);
  let touched = 0;
  for (const t of targets) {
    const prs = await db.select().from(pullRequests).where(and(eq(pullRequests.repositoryId, t.repo.id), eq(pullRequests.headSha, String(run.head_sha))));
    const byNumber = numbers.length ? await db.select().from(pullRequests).where(and(eq(pullRequests.repositoryId, t.repo.id), inArray(pullRequests.number, numbers))) : [];
    const mine = new Map([...prs, ...byNumber].map((p) => [p.id, p]));
    for (const pr of mine.values()) {
      if (pr.headSha !== String(run.head_sha)) continue; // a result for a commit that is no longer the head
      const checks: typeof pr.checks = { ...pr.checks, [run.name]: { status: String(run.status), conclusion: run.conclusion ?? null, url: run.html_url ?? null } };
      const next: CheckState | null = ciState(checks);
      await db.update(pullRequests).set({ checks, ciState: next, updatedAt: new Date() }).where(eq(pullRequests.id, pr.id));
      touched++;
      if (next !== pr.ciState && (next === "failure" || next === "success")) {
        const links = await db.select({ issueId: pullRequestIssues.issueId }).from(pullRequestIssues).where(eq(pullRequestIssues.pullRequestId, pr.id));
        const actor = githubActor(t.team.workspaceId, t.team.id);
        for (const l of links) {
          const [tk] = await db.select().from(issues).where(eq(issues.id, l.issueId));
          if (!tk) continue;
          const ref = `${t.team.key}-${tk.number}`;
          const failed = Object.entries(checks).filter(([, c]) => c.status === "completed" && c.conclusion && c.conclusion !== "success" && c.conclusion !== "neutral" && c.conclusion !== "skipped").map(([n]) => n);
          await emit(db, actor, t.team.id, {
            type: "issue.ci",
            entity: "issue",
            entityId: tk.id,
            summary: next === "failure" ? `CI failed on pull request #${pr.number} for ${ref}: ${failed.join(", ")}` : `CI passed on pull request #${pr.number} for ${ref}`,
            data: { ref, number: pr.number, ciState: next, failed },
          });
          if (next === "failure") await addComment(actor, ref, `CI failed on pull request [#${pr.number}](${pr.url}): ${failed.join(", ")}`);
        }
      }
    }
  }
  return { status: touched ? "handled" : "ignored", matched: touched, detail: touched ? undefined : "no matching pull request" };
}

// ───────── reading ─────────

/** Pull requests linked to an issue, newest first, for the issue view and for agents. */
export async function pullRequestsForIssue(issueId: string) {
  const db = await getDb();
  return db
    .select({
      number: pullRequests.number,
      title: pullRequests.title,
      url: pullRequests.url,
      state: pullRequests.state,
      draft: pullRequests.draft,
      ciState: pullRequests.ciState,
      headBranch: pullRequests.headBranch,
      repository: repositories.displayName,
      updatedAt: pullRequests.updatedAt,
    })
    .from(pullRequestIssues)
    .innerJoin(pullRequests, eq(pullRequests.id, pullRequestIssues.pullRequestId))
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .where(eq(pullRequestIssues.issueId, issueId))
    .orderBy(desc(pullRequests.updatedAt));
}
