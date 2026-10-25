import type { AgentProfile } from "../schema";
import { versions as backend } from "./backend";
import { versions as frontend } from "./frontend";
import { versions as fullstack } from "./fullstack";
import { versions as database } from "./database";
import { versions as reviewer } from "./reviewer";
import { versions as architect } from "./architect";

export const CATALOG: Record<string, AgentProfile[]> = { backend, frontend, fullstack, database, reviewer, architect };

export const latest = (slug: string): AgentProfile | undefined => CATALOG[slug]?.at(-1);
