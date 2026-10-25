import { z } from "zod";

/**
 * Who a broadcast reaches. A union on `kind` so a new audience (a workspace, a team, a list of people) is one more member and one more
 * case in the service, and nothing that sends changes shape. Today: everyone with an account.
 */
export const broadcastAudience = z.discriminatedUnion("kind", [z.object({ kind: z.literal("everyone") })]);
export type BroadcastAudience = z.output<typeof broadcastAudience>;

/** What a sender hands to `send`. `key` names the send: the same key again is the same broadcast, delivered once. */
export const broadcastInput = z.object({
  key: z.string().min(1).max(150),
  source: z.string().min(1).max(64).default("wheelhouse"),
  type: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  body: z.string().max(5000).default(""),
  bodyFormat: z.enum(["text", "markdown"]).default("text"),
  href: z.string().max(2000).nullish(),
  /** The name the inbox shows as the sender. */
  actorName: z.string().min(1).max(200).default("Wheelhouse"),
  audience: broadcastAudience,
});
export type BroadcastInput = z.input<typeof broadcastInput>;
export type ParsedBroadcastInput = z.output<typeof broadcastInput>;
