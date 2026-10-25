import { z } from "zod";

/** What a producer hands to `notify`. Optional fields may be omitted; `dedupeKey` makes a repeat for the same recipient a no-op. */
export const notificationInput = z.object({
  /** The workspace the item belongs to, or null for an instance-level one (a broadcast), which the person sees in every workspace of theirs. */
  workspaceId: z.uuid().nullable(),
  teamId: z.uuid().nullish(),
  recipientUserId: z.uuid(),
  source: z.string().min(1).max(64),
  type: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  body: z.string().max(5000).default(""),
  /** How the reader shows `body`: as it is, or as markdown. A producer that writes plain text leaves it out. */
  bodyFormat: z.enum(["text", "markdown"]).default("text"),
  actorKind: z.enum(["human", "agent", "system"]).nullish(),
  actorId: z.uuid().nullish(),
  actorName: z.string().max(200).nullish(),
  subjectEntity: z.string().max(64).nullish(),
  subjectId: z.uuid().nullish(),
  href: z.string().max(2000).nullish(),
  data: z.record(z.string(), z.unknown()).default({}),
  dedupeKey: z.string().min(1).max(200).nullish(),
  /** The broadcast this item is one delivery of, set by the broadcasts module. */
  broadcastId: z.uuid().nullish(),
});
export type NotificationInput = z.input<typeof notificationInput>;
export type ParsedNotificationInput = z.output<typeof notificationInput>;

/** The query of a list: a page of the recipient's inbox, newest first. `cursor` is the id of the last item of the previous page; `teamId` keeps one team's items. */
export const listNotificationsQuery = z.object({
  view: z.enum(["inbox", "archived", "trash"]).default("inbox"),
  cursor: z.uuid().nullish(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: z.union([z.boolean(), z.enum(["true", "false"])]).default(false).transform((v) => v === true || v === "true"),
  teamId: z.uuid().nullish(),
});
export type ListNotificationsInput = z.input<typeof listNotificationsQuery>;
export type ListNotificationsQuery = z.output<typeof listNotificationsQuery>;

/** The query of the unread count: all of the recipient's unread items, or only one team's. */
export const notificationCountQuery = z.object({
  teamId: z.uuid().nullish(),
});
export type NotificationCountInput = z.input<typeof notificationCountQuery>;
export type NotificationCountQuery = z.output<typeof notificationCountQuery>;
