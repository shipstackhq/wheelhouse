import { Inject, Injectable } from "@nestjs/common";
import { IDEA_STATUSES, type IdeaStatus } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { cleanLabels } from "../../common/labels";
import { Database } from "../../platform/database/database";
import { IssuesService } from "../issues/index";
import { TeamAccessService } from "../teams/index";
import { IdeasRepository, type IdeaCommentRow, type IdeaRow } from "./ideas.repository";

/**
 * Ideas (WH-109): a light place for what is not yet work, apart from docs (decided things) and issues (committed work). They belong to
 * the workspace and every member except a guest sees them; the team is only a tag. Promoting one files an issue in a team and links
 * the two both ways: the issue's text names the idea, and the idea becomes `promoted` and names the issue.
 */

const TITLE_MAX = 200;
const BODY_MAX = 20_000;

export type IdeaSummary = {
  id: string;
  title: string;
  status: IdeaStatus;
  author: { kind: "human" | "agent"; name: string };
  team: { id: string; key: string; name: string } | null;
  commentCount: number;
  promotedIssue: { id: string; ref: string; title: string } | null;
  createdAt: Date;
  updatedAt: Date;
};
export type IdeaComment = { id: string; authorKind: "human" | "agent"; authorName: string; body: string; createdAt: Date };
export type IdeaDetail = IdeaSummary & { body: string; version: number; labels: string[]; comments: IdeaComment[]; canEdit: boolean };

const bad = (field: string, message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

function str(v: unknown, field: string, max: number, required = false): string | undefined {
  if (v === undefined) return required ? bad(field, `${field} is required`) : undefined;
  if (typeof v !== "string") return bad(field, `${field} must be text`);
  const t = v.trim();
  if (required && !t) return bad(field, `${field} is required`);
  if (t.length > max) return bad(field, `${field} is at most ${max} characters`);
  return t;
}

const commentView = (c: IdeaCommentRow): IdeaComment => ({ id: c.id, authorKind: c.authorKind, authorName: c.authorName, body: c.body, createdAt: c.createdAt });

@Injectable()
export class IdeasService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(IdeasRepository) private readonly repo: IdeasRepository,
    @Inject(IssuesService) private readonly issues: IssuesService,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
  ) {}

  /** Who may write: a teammate who is not a viewer. Reading is for every member but a guest; to anyone else the workspace has no ideas. */
  private async may(actor: Actor, write: boolean) {
    if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", "Only teammates work with ideas");
    const role = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!role || role === "guest") throw new ServiceError("not_found", "Idea not found");
    if (write && role === "viewer") throw new ServiceError("forbidden", "Your role on this workspace is read only");
  }

  private async load(actor: Actor, id: string, write: boolean): Promise<IdeaRow> {
    await this.may(actor, write);
    const row = await this.repo.find(actor.workspaceId, id);
    if (!row) throw new ServiceError("not_found", "Idea not found");
    return row;
  }

  private async summaries(rows: IdeaRow[]): Promise<IdeaSummary[]> {
    const teamIds = [...new Set(rows.map((r) => r.teamId).filter((x): x is string => !!x))];
    const issueIds = rows.map((r) => r.promotedIssueId).filter((x): x is string => !!x);
    const [teams, issues, comments] = await Promise.all([this.repo.teamsByIds(teamIds), this.repo.issuesByIds(issueIds), this.repo.commentCounts(rows.map((r) => r.id))]);
    const counts = new Map<string, number>();
    for (const c of comments) counts.set(c.ideaId, (counts.get(c.ideaId) ?? 0) + 1);
    return rows.map((r) => {
      const issue = issues.find((i) => i.id === r.promotedIssueId);
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        author: { kind: r.authorKind, name: r.authorName },
        team: teams.find((t) => t.id === r.teamId) ?? null,
        commentCount: counts.get(r.id) ?? 0,
        promotedIssue: issue ? { id: issue.id, ref: `${issue.teamKey}-${issue.number}`, title: issue.title } : null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  /** The workspace's ideas, newest first; `status` keeps one status. */
  async list(actor: Actor, status?: unknown): Promise<IdeaSummary[]> {
    await this.may(actor, false);
    const s = status === undefined || status === "" ? undefined : (IDEA_STATUSES as readonly string[]).includes(status as string) ? (status as IdeaStatus) : bad("status", `status must be one of ${IDEA_STATUSES.join(", ")}`);
    return this.summaries(await this.repo.list(actor.workspaceId, s));
  }

  private async detail(actor: Actor, row: IdeaRow): Promise<IdeaDetail> {
    const [summary] = await this.summaries([row]);
    const comments = await this.repo.commentsOf(row.id);
    const role = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    return { ...summary, body: row.body, version: row.version, labels: row.labels, comments: comments.map(commentView), canEdit: role !== "viewer" };
  }

  async get(actor: Actor, id: string): Promise<IdeaDetail> {
    return this.detail(actor, await this.load(actor, id, false));
  }

  /** `{ title, body?, team? }`: `team` is a key or id of a team the author can open, and only tags the idea. */
  async create(actor: Actor, input: Record<string, unknown>): Promise<IdeaDetail> {
    await this.may(actor, true);
    const title = str(input.title, "title", TITLE_MAX, true)!;
    const body = str(input.body, "body", BODY_MAX) ?? "";
    let teamId: string | null = null;
    if (input.team !== undefined && input.team !== null && input.team !== "") {
      if (typeof input.team !== "string") bad("team", "team must be a team key or id");
      teamId = (await this.access.require(actor, input.team as string, "read")).id;
    }
    const row = await this.repo.insert({ workspaceId: actor.workspaceId, teamId, title, body, authorKind: actor.kind, authorId: actor.id, authorName: actor.name });
    return this.detail(actor, row);
  }

  /**
   * `{ title?, body?, status?, team?, labels?, version? }`. `promoted` is only reached by promoting; an idea that was promoted keeps that
   * status but its text stays editable. `version` is the one the edit started from: a change made since is a conflict and nothing is saved.
   */
  async update(actor: Actor, id: string, input: Record<string, unknown>): Promise<IdeaDetail> {
    return this.db.transaction(async () => {
      await this.may(actor, true);
      const row = await this.repo.lock(actor.workspaceId, id);
      if (!row) throw new ServiceError("not_found", "Idea not found");
      if (input.version !== undefined && input.version !== null) {
        if (typeof input.version !== "number" || !Number.isSafeInteger(input.version)) bad("version", "version must be a whole number");
        if (input.version !== row.version) {
          throw new ServiceError("conflict", `Idea "${row.title}" was changed (version ${row.version}, you had ${input.version}). Re-read and retry.`, { current: await this.detail(actor, row) });
        }
      }
      const set: Partial<IdeaRow> = { version: row.version + 1 };
      if (input.labels !== undefined) {
        if (!Array.isArray(input.labels) || input.labels.some((l) => typeof l !== "string")) bad("labels", "labels must be a list of text");
        set.labels = cleanLabels(input.labels as string[], "idea");
      }
      const title = str(input.title, "title", TITLE_MAX, input.title !== undefined);
      if (title !== undefined) set.title = title;
      const body = str(input.body, "body", BODY_MAX);
      if (body !== undefined) set.body = body;
      if (input.status !== undefined) {
        if (typeof input.status !== "string" || !(IDEA_STATUSES as readonly string[]).includes(input.status)) bad("status", `status must be one of ${IDEA_STATUSES.join(", ")}`);
        if (input.status === "promoted" && row.status !== "promoted") bad("status", "Promote the idea to an issue instead");
        if (row.status === "promoted" && input.status !== "promoted") bad("status", "A promoted idea stays promoted");
        set.status = input.status as IdeaStatus;
      }
      if (input.team !== undefined) {
        if (input.team === null || input.team === "") set.teamId = null;
        else if (typeof input.team !== "string") bad("team", "team must be a team key or id, or null");
        else set.teamId = (await this.access.require(actor, input.team as string, "read")).id;
      }
      return this.detail(actor, await this.repo.update(id, set));
    });
  }

  async comment(actor: Actor, id: string, body: unknown): Promise<IdeaComment> {
    const text = str(body, "body", BODY_MAX, true)!;
    const idea = await this.load(actor, id, true);
    const c = await this.repo.insertComment({ ideaId: idea.id, authorKind: actor.kind, authorId: actor.id, authorName: actor.name, body: text });
    return commentView(c);
  }

  /**
   * `{ team }`: file the idea as an issue in that team (the person needs edit rights there) in one transaction. The issue carries the
   * idea's text and a link back; the idea becomes `promoted` and names the issue. Priority, assignee and the rest are set on the issue.
   */
  async promote(actor: Actor, id: string, input: Record<string, unknown>): Promise<IdeaDetail> {
    return this.db.transaction(async () => {
      await this.may(actor, true);
      const row = await this.repo.lock(actor.workspaceId, id);
      if (!row) throw new ServiceError("not_found", "Idea not found");
      if (row.status === "promoted") throw new ServiceError("conflict", "This idea was already promoted");
      const teamRef = typeof input.team === "string" && input.team ? input.team : row.teamId;
      if (!teamRef) return bad("team", "team is required");
      const link = `Promoted from the idea [${row.title}](/ideas/${row.id}).`;
      const issue = await this.issues.createIssue(actor, teamRef, { title: row.title, body: row.body ? `${row.body}\n\n---\n${link}` : link });
      return this.detail(actor, await this.repo.update(row.id, { status: "promoted", promotedIssueId: issue.id, version: row.version + 1 }));
    });
  }
}
