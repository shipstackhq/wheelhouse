/**
 * MCP prompts. Claude Code surfaces these as slash commands
 * (/mcp__wheelhouse__map_codebase etc.), so they're the guided entry points for
 * building and maintaining the knowledge map.
 */

type Prompt = {
  description: string;
  arguments: { name: string; description: string; required?: boolean }[];
  render: (args: Record<string, string>) => string;
};

export const prompts: Record<string, Prompt> = {
  brief: {
    description: "Load the Wheelhouse briefing for this project (what it is, how it's built, work in flight, what changed).",
    arguments: [{ name: "project", description: 'Wheelhouse project key, e.g. "WH"', required: true }],
    render: ({ project }) => `Call get_briefing for Wheelhouse project ${project} and read it carefully: it is the current state of the project and replaces exploring the codebase from scratch. Then call get_changes and handle anything addressed to you. If you're about to work a ticket, call get_ticket_context for it and start with the files it lists. Summarise in 3–5 lines what you now know and what you'll do next.`,
  },

  map_codebase: {
    description: "Build the Wheelhouse knowledge map for this repo: concepts → systems → code, plus key flows, decisions and glossary.",
    arguments: [
      { name: "project", description: 'Wheelhouse project key, e.g. "WH"', required: true },
      { name: "focus", description: "Optional: limit to one area (directory or feature)" },
    ],
    render: ({ project, focus }) => `Build the knowledge map for Wheelhouse project ${project}${focus ? `, focused on: ${focus}` : ""}.

Goal: a teammate should understand this codebase at a high level from the map alone, without reading code.

1. Call get_graph for ${project} to see what already exists; extend and correct it, don't duplicate.
2. Explore the repo (README, entry points, routing, schema, package boundaries). Then write the map top-down:
   a. CONCEPT layer (layer "concept"): 4–10 product concepts/capabilities and actors, described in product language — what the system does and why, no file names. Define project-specific vocabulary with upsert_term.
   b. SYSTEM layer: deployable services/apps, datastores, queues and external services as top-level nodes; their major modules nested via parent. Connect them with depends edges (label the protocol: REST, SQL, events…). Link each system node to the concept(s) it serves with implements.
   c. DATA layer: every table, view and enum with upsert_table: full column lists (types, pk, nullable, unique, defaults), foreign keys via column.references ("table.column") so relationships draw themselves, indexes that matter, anchors to the schema/migration files, and implements links to the concept each table stores and the system database it lives in.
   d. CODE layer: the directories, key files, tables and endpoints behind each system node — only the ones that matter for understanding (aim for signal, not a file listing). Link each to the system node it implements.
3. For every system and code node, set anchors (paths or globs) and fill the explainer: summary (one line), purpose, responsibilities (bullets), interfaces (inputs/outputs/APIs), gotchas (invariants, traps, non-obvious behaviour). Pass described_sha = output of \`git rev-parse HEAD\`.
4. Write 3–6 flows for the most important paths (e.g. a request lifecycle, sign-up, the core domain operation). Each step points at the node where it happens, at whichever layer explains it best.
5. Record ADRs (upsert_decision) for non-obvious choices you find evidence of in code comments, docs or commit history.
6. Finish with a short comment-style summary of what you mapped and what you were unsure about.`,
  },

  map_schema: {
    description: "Map the database schema into the Wheelhouse data layer: tables, columns, foreign keys, indexes, enums.",
    arguments: [{ name: "project", description: 'Wheelhouse project key, e.g. "WH"', required: true }],
    render: ({ project }) => `Map this repo's database schema into the data layer of Wheelhouse project ${project}.

1. Find the source of truth for the schema: ORM schema files (Drizzle, Prisma, TypeORM, SQLAlchemy, ActiveRecord…), SQL migrations, or DDL. If several exist, prefer the ORM schema and cross-check the latest migrations.
2. Call get_schema for ${project} to see what's already mapped; update rather than duplicate.
3. For every table, view and enum, call upsert_table with:
   - all columns in schema order: type as written, pk, nullable, unique, default; set references: "table.column" for every foreign key (with onDelete when specified)
   - indexes that matter (unique constraints, composite indexes)
   - summary (one line: what one row represents) and gotchas (soft deletes, denormalised fields, JSON shapes, invariants)
   - anchors: the schema file with "#tableName" and the migration that created it
   - implements: the concept it stores (create the concept with upsert_node layer "concept" if missing) and the system database node it lives in
   - described_sha: output of \`git rev-parse HEAD\`
4. Re-check the \`unresolved\` lists returned; every FK target should end up mapped.
5. Add glossary terms (upsert_term) for domain words that appear as table or column names, and an ADR for any notable modelling choice (e.g. soft deletes, multi-tenancy by team_id, JSONB over tables).
Report the number of tables and relationships mapped and anything you couldn't resolve.`,
  },

  refresh_map: {
    description: "Re-describe Wheelhouse map nodes whose code changed (stale nodes).",
    arguments: [{ name: "project", description: 'Wheelhouse project key, e.g. "WH"', required: true }],
    render: ({ project }) => `Refresh stale parts of the Wheelhouse knowledge map for project ${project}.

1. Call get_stale_nodes for ${project}.
2. For each stale node: get_node, re-read its anchored files (and the changed files in its stale reason), then either
   - update the explainer fields that are now wrong (this clears the flag), or
   - mark_fresh if the explanation is still accurate.
   Pass the current \`git rev-parse HEAD\` as described_sha / sha.
3. If the change introduced a new module, file or dependency that matters, add nodes/edges/implements links for it and adjust any flow whose steps changed.
4. If the change embodied a non-obvious decision, record it with upsert_decision.
Report what you updated.`,
  },

  explain: {
    description: "Explain part of the system from the Wheelhouse map (and code if needed), then fill gaps in the map.",
    arguments: [
      { name: "project", description: 'Wheelhouse project key, e.g. "WH"', required: true },
      { name: "topic", description: "What to explain, e.g. a feature, node or flow", required: true },
    ],
    render: ({ project, topic }) => `Explain "${topic}" in Wheelhouse project ${project}.

Start from the map: get_graph, then get_node / get_flows for the relevant parts. Explain at a high level first (concepts and systems involved, the flow between them), then point to the code anchors.
If the map is missing or wrong about anything you had to read code to answer, fix it (upsert_node, upsert_flow, upsert_term) so the next person doesn't have to.`,
  },
};

export function listPromptDefs() {
  return Object.entries(prompts).map(([name, p]) => ({ name, description: p.description, arguments: p.arguments }));
}

export function getPrompt(name: string, args: Record<string, string>) {
  const p = prompts[name];
  if (!p) return null;
  for (const a of p.arguments) if (a.required && !args[a.name]) throw new Error(`Missing required argument: ${a.name}`);
  return {
    description: p.description,
    messages: [{ role: "user", content: { type: "text", text: p.render(args) } }],
  };
}
