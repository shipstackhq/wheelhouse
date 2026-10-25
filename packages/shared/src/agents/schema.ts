import { z } from "zod";
import { AVATAR_STYLES } from "./avatar";

export const AGENT_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"] as const;
export const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

const line = (max: number) => z.string().trim().min(1).max(max);

export const agentProfileSchema = z
  .object({
    schemaVersion: z.literal(1),

    slug: z.string().regex(/^[a-z0-9-]{2,32}$/),
    name: line(16).min(2),
    role: line(40),
    summary: line(120),
    avatar: z.object({
      style: z.enum(AVATAR_STYLES),
      seed: line(64),
    }),
    color: z.enum(AGENT_COLORS),

    description: line(300),

    instructions: z.string().trim().min(1).max(8000),
    rules: z.array(z.object({ rule: line(300), why: line(300).optional(), example: line(500).optional() })).max(20),
    style: z.object({
      verbosity: z.enum(["terse", "normal", "detailed"]),
      explainChanges: z.boolean(),
      notes: line(500).optional(),
    }),
    done: z.array(line(200)).max(20),
    askWhen: z.array(line(200)).max(20),

    kind: z.enum(["builder", "advisor"]),
    toolProfile: z.enum(["edit", "read-only", "custom"]),
    tools: z.array(line(64)).max(64).optional(),
    disallowedTools: z.array(line(64)).max(64).optional(),
    pathScope: z.array(line(200)).max(20),
    skills: z.array(line(64)).max(32),

    model: z.enum(["inherit", "opus", "sonnet", "haiku"]),
    effort: z.enum(["low", "medium", "high"]).nullable(),
    maxTurns: z.number().int().min(1).max(500).nullable(),
  })
  .superRefine((p, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (p.toolProfile !== "custom" && p.tools) bad("tools", "tools is only for the custom tool profile");
    if (p.toolProfile === "custom" && !p.tools?.length) bad("tools", "the custom tool profile needs a tools list");
    const editsFiles = p.toolProfile === "edit" || !!p.tools?.some((t) => EDIT_TOOLS.includes(t));
    if (editsFiles && (p.kind === "advisor" || p.toolProfile === "read-only")) bad("tools", "a read-only or advisor agent cannot have edit tools");
  });

export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentColor = AgentProfile["color"];

export function parseAgentProfile(input: unknown): AgentProfile {
  return agentProfileSchema.parse(input);
}
