import { z } from "zod";
import { agentProfileSchema } from "@wheelhouse/shared/agents/schema";

/** `{ version }`: a catalog version to pin, or null to follow the latest. */
export const pinDto = z.object({ version: z.number().int().min(1).nullable() });
export type PinDto = z.infer<typeof pinDto>;

/** `{ profile, teamKey? }`: a custom agent, workspace-wide or (with `teamKey`) one team's. A bad profile fails per field (`profile.name`). */
export const createAgentDto = z.object({ profile: agentProfileSchema, teamKey: z.string().min(1).optional() });
export type CreateAgentDto = z.infer<typeof createAgentDto>;

/** `{ profile }` or `{ avatar }`, not both. */
export const updateAgentDto = z
  .object({ profile: agentProfileSchema.optional(), avatar: agentProfileSchema.shape.avatar.optional() })
  .refine((b) => (b.profile === undefined) !== (b.avatar === undefined), { message: "Send either profile or avatar", path: ["profile"] });
export type UpdateAgentDto = z.infer<typeof updateAgentDto>;

/** `{ slug }`: the agent to put on a team's roster. */
export const rosterDto = z.object({ slug: z.string().min(1) });
export type RosterDto = z.infer<typeof rosterDto>;
