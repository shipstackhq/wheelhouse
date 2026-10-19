/**
 * Doc templates (WH-65): five static Markdown skeletons offered when creating a new
 * doc, for humans ("New doc" picker in docs-explorer.tsx) and agents (`list_doc_templates`,
 * or `upsert_doc`'s `template` arg). Each is just a `body` string handed to `createDoc` on
 * creation — no schema, no DB access, nothing persisted here. Keep this list static and
 * small; per-team customization (the ticket's "editable later") can layer on top
 * without changing this module's shape.
 */

export type DocTemplateId = "spec" | "decision-record" | "runbook" | "meeting-notes" | "onboarding";

export type DocTemplate = {
  id: DocTemplateId;
  name: string;
  description: string;
  body: string;
};

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: "spec",
    name: "Spec / PRD",
    description: "Problem, users, goals and non-goals, approach, open questions, ticket links.",
    body: `# Spec: <title>

## Problem
*What problem are we solving, for whom?*

## Users
*Who is affected, and how do they experience this today?*

## Goals
*What does success look like?*

## Non-goals
*What are we explicitly not doing here?*

## Approach
*What are we building, at a level someone outside the work can follow?*

## Open questions
*What's still unresolved?*

## Related tickets
*Link the tickets this spec feeds into.*
`,
  },
  {
    id: "decision-record",
    name: "Decision record",
    description: "Context, options considered, decision, consequences — the long-form companion to an ADR.",
    body: `# Decision: <title>

## Context
*What's the situation that forced a decision?*

## Options considered
*What alternatives did we weigh, and why didn't we pick them?*

## Decision
*What did we decide?*

## Consequences
*What does this make easier, harder, or impossible going forward?*

## ADR
*Link or create the short-form ADR that records this decision.*
`,
  },
  {
    id: "runbook",
    name: "Runbook",
    description: "When to use, steps, how to verify, how to roll back, owner.",
    body: `# Runbook: <title>

## When to use this
*What triggers this runbook — an alert, a request, a scheduled task?*

## Steps
1. *First step.*
2. *Next step.*

## How to verify
*How do you know it worked?*

## How to roll back
*If it goes wrong, how do you undo it?*

## Owner
*Who maintains this runbook, and who to page if it's unclear?*
`,
  },
  {
    id: "meeting-notes",
    name: "Meeting / retro notes",
    description: "Who, decisions, action items — action items can become tickets in one click.",
    body: `# Meeting notes: <title>

## Who
*Attendees and date.*

## Decisions
*What did we decide?*

## Action items
*Unchecked items below can be turned into tickets with one click.*
- [ ] *Action item one — owner, by when.*
- [ ] *Action item two — owner, by when.*
`,
  },
  {
    id: "onboarding",
    name: "Onboarding",
    description: "What this team is, how to run it, where things are, who to ask.",
    body: `# Onboarding: <title>

## What this team is
*A short orientation for someone new.*

## How to run it
*Setup and the commands to get it running locally.*

## Where things are
*Link the map nodes/areas of the codebase that matter most.*

## Who to ask
*Who owns what, and where to go with questions.*
`,
  },
];

export const DOC_TEMPLATE_IDS = DOC_TEMPLATES.map((t) => t.id) as [DocTemplateId, ...DocTemplateId[]];

/** Look up one template by id, or undefined if the id isn't one of the five. */
export function getDocTemplate(id: string | undefined | null): DocTemplate | undefined {
  if (!id) return undefined;
  return DOC_TEMPLATES.find((t) => t.id === id);
}

/** Light metadata list (id/name/description, no bodies) for pickers and the `list_doc_templates` tool. */
export function listDocTemplates(): Pick<DocTemplate, "id" | "name" | "description">[] {
  return DOC_TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));
}

/**
 * Find unchecked GFM task-list items ("- [ ] text") under an "Action items" heading
 * (or similar — matched case-insensitively against common phrasings) in a doc's Markdown
 * body. Used to back the one-click "Create ticket" affordance in the docs UI: this is
 * pure text processing, no DOM/markdown-AST dependency, so it's easy to unit test and
 * easy to reason about. Not a full Markdown parser — a heading line starts with one or
 * more "#", and the section ends at the next heading of equal-or-shallower depth.
 */
const ACTION_ITEMS_HEADING_RE = /^action\s*items?$/i;

export function extractActionItems(markdown: string): { text: string; line: number }[] {
  const lines = markdown.split("\n");
  const items: { text: string; line: number }[] = [];
  let inSection = false;
  let sectionDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const text = heading[2].trim();
      if (inSection && depth <= sectionDepth) {
        inSection = false;
      }
      if (ACTION_ITEMS_HEADING_RE.test(text)) {
        inSection = true;
        sectionDepth = depth;
      }
      continue;
    }
    if (!inSection) continue;
    const task = /^\s*-\s*\[( |x|X)\]\s*(.+)$/.exec(line);
    if (task && task[1] === " ") {
      items.push({ text: task[2].trim(), line: i });
    }
  }
  return items;
}
