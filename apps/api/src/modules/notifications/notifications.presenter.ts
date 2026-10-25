import type { NotificationRow } from "./notifications.repository";
import { PURGE_AFTER_DAYS } from "./notifications.service";

/** An inbox item as the people's side shows it: what a row needs to render and link, never the recipient, the dedupe key or the raw data. */
export type NotificationView = {
  id: string;
  teamId: string | null;
  type: string;
  source: string;
  title: string;
  body: string;
  bodyFormat: "text" | "markdown";
  href: string | null;
  actor: { kind: "human" | "agent" | "system"; name: string | null } | null;
  subject: { entity: string; id: string | null } | null;
  readAt: Date | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  /** When the purge removes a deleted item for good; null while it is not deleted. */
  purgeAt: Date | null;
  createdAt: Date;
};

export const notificationView = (r: NotificationRow): NotificationView => ({
  id: r.id,
  teamId: r.teamId,
  type: r.type,
  source: r.source,
  title: r.title,
  body: r.body,
  bodyFormat: r.bodyFormat,
  href: r.href,
  actor: r.actorKind ? { kind: r.actorKind, name: r.actorName } : null,
  subject: r.subjectEntity ? { entity: r.subjectEntity, id: r.subjectId } : null,
  readAt: r.readAt,
  archivedAt: r.archivedAt,
  deletedAt: r.deletedAt,
  purgeAt: r.deletedAt ? new Date(r.deletedAt.getTime() + PURGE_AFTER_DAYS * 86_400_000) : null,
  createdAt: r.createdAt,
});
