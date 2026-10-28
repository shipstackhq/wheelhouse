import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DelegationState, IssueTarget } from "@wheelhouse/api-client";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { issuePlanQuery, issueRunsQuery } from "../../lib/queries";
import { useServices } from "../../lib/services";
import { BaseBranchPicker } from "./issue-runs";

export type TargetChoice = { repository: string; branch?: string };

const STATE_TEXT: Record<DelegationState, string> = {
  needs_setup: "Needs setup: pick where the agent should work and it starts.",
  waiting: "Waiting for one of your devices to come online, or for a pull request to review.",
  running: "The agent is working on it.",
  asked: "The agent has a question: answer it in the comments below.",
  done: "The agent is done.",
  failed: "The agent's run failed.",
  stopped: "The agent was stopped.",
};

/**
 * Where an agent's work on the issue happens (WH-129): repositories, each with the branch the work starts from; the work branch is
 * generated. A sub-issue without its own list uses its parent's, and editing it makes an own list. Also says where a delegation stands.
 */
export function IssueTargetsSection({ issueRef, targets, proposed, inherited, delegation, busy, onChange }: {
  issueRef: string;
  targets: IssueTarget[];
  proposed: IssueTarget[];
  inherited: boolean;
  delegation: DelegationState | null;
  busy: boolean;
  onChange: (targets: TargetChoice[]) => void;
}) {
  const { api } = useServices();
  const repos = useQuery(issueRunsQuery(api, issueRef)).data?.repositories ?? [];
  const names = new Map(repos.map((r) => [r.id, r]));
  const [suggested, setSuggested] = useState<IssueTarget[]>([]);
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const suggest = async () => {
    setSuggesting("");
    try {
      const found = await api.issues.suggestTargets(issueRef);
      setSuggested(found);
      setSuggesting(found.length ? null : "Nothing to suggest from the issue and the map.");
    } catch (e) {
      setSuggesting(describeFailure(e));
    }
  };
  const offered = proposed.length ? proposed : suggested;
  const current: TargetChoice[] = targets.map((t) => ({ repository: t.repositoryId, branch: t.baseBranch }));
  const free = repos.filter((r) => !targets.some((t) => t.repositoryId === r.id));
  const set = (i: number, next: TargetChoice | null) => onChange(current.flatMap((c, j) => (j !== i ? [c] : next ? [next] : [])));
  if (!repos.length && !targets.length && !proposed.length && !delegation) return null;
  return (
    <section aria-label="Where it runs">
      <span className="label">Where it runs</span>
      {delegation && <p className={delegation === "needs_setup" || delegation === "failed" ? "mb-1 text-sm text-warn" : "mb-1 text-sm text-muted"}>{STATE_TEXT[delegation]}</p>}
      <ul className="space-y-1">
        {targets.map((t, i) => (
          <li key={t.repositoryId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs">{names.get(t.repositoryId)?.name ?? t.repository}</span>
            <BaseBranchPicker issueRef={issueRef} repositoryId={t.repositoryId} value={t.baseBranch} onChange={(b) => set(i, { repository: t.repositoryId, branch: b ?? undefined })} />
            <button type="button" className="btn py-0.5 text-xs" disabled={busy} aria-label={`Remove ${t.repository}`} onClick={() => set(i, null)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {inherited && targets.length > 0 && <p className="mt-1 text-xs text-muted">From the parent issue or the project. Changing them gives this issue its own.</p>}
      {!targets.length && offered.length > 0 && (
        <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Suggested: {offered.map((t) => `${t.repository} · ${t.baseBranch}`).join(", ")}</span>
          <button type="button" className="btn btn-primary py-0.5 text-xs" disabled={busy} onClick={() => onChange(offered.map((t) => ({ repository: t.repositoryId, branch: t.baseBranch })))}>
            Confirm{delegation === "needs_setup" ? " and start" : ""}
          </button>
        </div>
      )}
      {!targets.length && !offered.length && repos.length > 0 && (
        <div className="mb-1 flex items-center gap-2 text-sm">
          <button type="button" className="btn py-0.5 text-xs" disabled={suggesting === ""} onClick={() => void suggest()}>
            Suggest where
          </button>
          {suggesting && <span className="text-xs text-muted">{suggesting}</span>}
        </div>
      )}
      {free.length > 0 && (
        <Select
          className="mt-1 !w-auto"
          ariaLabel="Add repository"
          value=""
          placeholder="Add a repository…"
          options={free.map((r) => ({ value: r.id, label: r.name }))}
          onValueChange={(v) => v && onChange([...current, { repository: v }])}
        />
      )}
    </section>
  );
}

/** What starting the delegated issue would do (the planner's answer): "wheelhouse · development · MacBook Pro · opus" per target, or what is missing. */
export function DelegatePlan({ issueRef, agent }: { issueRef: string; agent: string }) {
  const { api } = useServices();
  const plan = useQuery(issuePlanQuery(api, issueRef, agent)).data;
  if (!plan) return null;
  if ("missing" in plan) return <p className="mt-1 text-xs text-muted">{plan.missing === "needs_setup" ? "Needs setup: pick where it runs, below." : "Waiting for one of your devices to come online."}</p>;
  return (
    <ul className="mt-1 text-xs text-muted">
      {plan.plans.map((p) => (
        <li key={p.repository}>
          {[p.repository, p.baseBranch, p.device, p.effort ? `${p.model}, ${p.effort} effort` : p.model].join(" · ")}
          {p.note && <span className="text-warn"> ({p.note})</span>}
        </li>
      ))}
    </ul>
  );
}
