import { useState } from "react";
import { Dialog } from "radix-ui";
import { randomSeed } from "@wheelhouse/shared/agents/avatar";
import type { AgentProfile } from "@wheelhouse/api-client";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { useServices } from "../../lib/services";
import { useAgentRights } from "../../lib/agent-teams";
import { refreshAll } from "../../lib/refresh";

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

const NEW: AgentProfile = {
  schemaVersion: 1, slug: "", name: "", role: "", summary: "", avatar: { style: "notionists", seed: "" }, color: "blue", description: "",
  instructions: "", rules: [], style: { verbosity: "normal", explainChanges: true }, done: [], askWhen: [], kind: "builder", toolProfile: "edit",
  pathScope: [], skills: [], model: "inherit", effort: null, maxTurns: null,
};

const KINDS = [{ value: "builder", label: "Builder (changes code)" }, { value: "advisor", label: "Advisor (reviews, plans)" }];
const MODELS = ["inherit", "opus", "sonnet", "haiku"].map((value) => ({ value, label: value === "inherit" ? "Default model" : value }));

/** The simple form over the agent schema: make a custom agent (`agent` left out) or edit one. Anything the form does not show is kept as it was. */
export function AgentForm({ open, onOpenChange, agent }: { open: boolean; onOpenChange: (o: boolean) => void; agent?: AgentProfile }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl">
          <Body agent={agent} onOpenChange={onOpenChange} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({ agent, onOpenChange }: { agent?: AgentProfile; onOpenChange: (o: boolean) => void }) {
  const { api, queryClient } = useServices();
  const { admin, teams } = useAgentRights();
  const base = agent ?? NEW;
  const [kind, setKind] = useState<string>(base.kind);
  const [tools, setTools] = useState<string>(base.toolProfile);
  const [model, setModel] = useState<string>(base.model);
  const scopes = [...(admin ? [{ value: "", label: "Whole workspace" }] : []), ...teams.map((t) => ({ value: t.key, label: `${t.name} only` }))];
  const [scope, setScope] = useState(scopes[0]?.value ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const save = async (fd: FormData) => {
    const name = text(fd, "name");
    const existing = base.rules;
    const profile: AgentProfile = {
      ...base,
      slug: agent ? agent.slug : text(fd, "slug") || slugify(name),
      name,
      role: text(fd, "role"),
      summary: text(fd, "summary"),
      description: text(fd, "description"),
      instructions: text(fd, "instructions"),
      rules: lines(text(fd, "rules")).map((rule) => existing.find((r) => r.rule === rule) ?? { rule }),
      done: lines(text(fd, "done")),
      askWhen: lines(text(fd, "askWhen")),
      kind: kind as AgentProfile["kind"],
      toolProfile: tools as AgentProfile["toolProfile"],
      model: model as AgentProfile["model"],
      avatar: agent ? agent.avatar : { ...base.avatar, seed: randomSeed() },
    };
    setSaving(true);
    setError(undefined);
    try {
      await (agent ? api.agents.update(agent.slug, { profile }) : api.agents.create(profile, scope || undefined));
      await refreshAll(queryClient);
      onOpenChange(false);
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setSaving(false);
    }
  };

  const input = (name: string, label: string, value: string, extra: { max?: number; placeholder?: string; required?: boolean } = {}) => (
    <label className="block text-sm">
      <span className="text-xs text-muted">{label}</span>
      <input className="input mt-1" name={name} defaultValue={value} maxLength={extra.max} placeholder={extra.placeholder} required={extra.required ?? true} />
    </label>
  );
  const area = (name: string, label: string, value: string, rows: number, required = false) => (
    <label className="block text-sm">
      <span className="text-xs text-muted">{label}</span>
      <textarea className="input mt-1 font-mono text-[13px]" name={name} defaultValue={value} rows={rows} required={required} />
    </label>
  );

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save(new FormData(e.currentTarget));
      }}
    >
      <Dialog.Title className="font-semibold">{agent ? `Edit ${agent.name}` : "New agent"}</Dialog.Title>
      <Dialog.Description className="text-xs text-muted">Made by your workspace, not by Wheelhouse: no warranty. Wheelhouse&apos;s guardrails are added to every agent.</Dialog.Description>
      <div className="grid grid-cols-2 gap-3">
        {input("name", "Name", base.name, { max: 16, placeholder: "Bram" })}
        {input("role", "Role", base.role, { max: 40, placeholder: "Backend engineer" })}
      </div>
      {!agent && input("slug", "Slug (optional, from the name)", "", { max: 32, required: false })}
      {input("summary", "Summary (one line for cards)", base.summary, { max: 120 })}
      {input("description", "When to use it", base.description, { max: 300 })}
      {area("instructions", "Instructions (markdown)", base.instructions, 6, true)}
      {area("rules", "Rules (one per line)", base.rules.map((r) => r.rule).join("\n"), 3)}
      {area("done", "Done means (one per line)", base.done.join("\n"), 3)}
      {area("askWhen", "Ask instead of guessing when (one per line)", base.askWhen.join("\n"), 3)}
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <span className="text-xs text-muted">Kind</span>
          <Select ariaLabel="Kind" options={KINDS} value={kind} onValueChange={setKind} className="mt-1" />
        </div>
        <div>
          <span className="text-xs text-muted">Tools</span>
          <Select
            ariaLabel="Tools"
            options={[{ value: "edit", label: "Can edit files" }, { value: "read-only", label: "Reads only" }, ...(base.toolProfile === "custom" ? [{ value: "custom", label: "Custom (kept)" }] : [])]}
            value={tools}
            onValueChange={setTools}
            className="mt-1"
          />
        </div>
        <div>
          <span className="text-xs text-muted">Model</span>
          <Select ariaLabel="Model" options={MODELS} value={model} onValueChange={setModel} className="mt-1" />
        </div>
      </div>
      {!agent && (
        <div className="text-sm">
          <span className="text-xs text-muted">Available to</span>
          <Select ariaLabel="Available to" options={scopes} value={scope} onValueChange={setScope} className="mt-1" />
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Dialog.Close type="button" className="btn">Cancel</Dialog.Close>
        <button className="btn btn-primary" disabled={saving}>{agent ? "Save" : "Create agent"}</button>
      </div>
    </form>
  );
}
