import { useState } from "react";
import { Link } from "../../lib/workspace";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import type { IssueRuns, IssueTarget, JobEvent, JobView } from "@wheelhouse/api-client";
import { timeAgo } from "@wheelhouse/shared/time";
import { ChevronRightIcon, ClaudeIcon, ExternalLinkIcon } from "../../components/icons";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { isActive, madeNoChanges, runStatus, type Tone } from "../../lib/run-status";
import { issueRunsQuery, runBranchesQuery, runEventsQuery, teamAgentsQuery } from "../../lib/queries";
import { useServices } from "../../lib/services";

/** A model name with the Claude mark beside it, wherever one is named: the picker, a run's row. */
function ModelLabel({ model }: { model: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <ClaudeIcon /> {model}
    </span>
  );
}

const TONE_STYLE: Record<Tone, string> = {
  active: "bg-agent/15 text-agent",
  good: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  bad: "bg-danger/15 text-danger",
  muted: "bg-panel-2 text-muted",
};
/**
 * Runs on a device: send the issue to an agent on one of your machines (the Wheelhouse daemon), and follow each run. A run works in a
 * worktree on its own branch and pushes it; the board itself is not changed by the agent yet.
 */
export function IssueRunsSection({ issueRef, teamKey, targets = [], delegated }: { issueRef: string; teamKey: string; targets?: IssueTarget[]; delegated?: boolean }) {
  const { api, queryClient } = useServices();
  const query = useQuery({ ...issueRunsQuery(api, issueRef), refetchInterval: (q) => (q.state.data?.jobs.some((j) => isActive(j.state)) ? 5_000 : false) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // With runs already listed, the start form stays closed until asked for.
  const [starting, setStarting] = useState(false);
  const data = query.data;
  if (!data) return null;
  const rerunDelegate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.runs.rerunDelegate(issueRef);
      await queryClient.invalidateQueries({ queryKey: issueRunsQuery(api, issueRef).queryKey });
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Runs on a device">
      <span className="label">Runs</span>
      <div className="space-y-3">
        {starting || data.jobs.length === 0 ? (
          <RunForm issueRef={issueRef} teamKey={teamKey} targets={targets} data={data} onStarted={() => setStarting(false)} />
        ) : (
          <button type="button" className="btn py-0.5 text-xs" onClick={() => setStarting(true)}>
            New run
          </button>
        )}
        {delegated && (
          <button type="button" className="btn py-0.5 text-xs" disabled={busy} onClick={() => void rerunDelegate()}>
            Rerun agent
          </button>
        )}
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        {data.jobs.length > 0 && <RunsTable jobs={data.jobs} issueRef={issueRef} repositories={data.repositories} />}
      </div>
    </section>
  );
}

function RunForm({ issueRef, teamKey, targets, data, onStarted }: { issueRef: string; teamKey: string; targets: IssueTarget[]; data: IssueRuns; onStarted: () => void }) {
  const { api, queryClient } = useServices();
  const roster = useQuery(teamAgentsQuery(api, teamKey)).data ?? [];
  const [agent, setAgent] = useState("");
  const online = data.devices.filter((d) => d.status === "online");
  const [deviceId, setDeviceId] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [model, setModel] = useState("");
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (data.devices.length === 0)
    return (
      <p className="text-sm text-muted">
        Pair a machine in <Link className="text-accent hover:underline" to="/settings/devices">Devices</Link> to have an agent on it work on this issue.
      </p>
    );
  if (data.repositories.length === 0) return <p className="text-sm text-muted">Connect a GitHub repository to this team so an agent can clone it.</p>;

  const device = online.find((d) => d.id === deviceId) ?? online[0];
  const models = device?.models ?? [];
  const chosenModel = models.includes(model) ? model : (models[0] ?? "");
  // Where it runs starts as the issue's first target; the other pickers are for running it elsewhere.
  const repo = data.repositories.find((r) => r.id === (repositoryId || targets[0]?.repositoryId)) ?? data.repositories[0];
  const baseBranch = base ?? (repo.id === targets[0]?.repositoryId ? targets[0].baseBranch : null);

  const start = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      await api.runs.start(issueRef, { deviceId: device.id, repositoryId: repo.id, model: chosenModel, baseBranch: baseBranch ?? undefined, agent: agent || undefined });
      await queryClient.invalidateQueries({ queryKey: issueRunsQuery(api, issueRef).queryKey });
      onStarted();
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {roster.length > 0 && (
          <Select className="!w-auto" ariaLabel="Agent" value={agent} options={[{ value: "", label: "No agent" }, ...roster.map((a) => ({ value: a.slug, label: a.name }))]} onValueChange={setAgent} />
        )}
        <Select
          className="!w-auto"
          ariaLabel="Device"
          value={device?.id ?? ""}
          placeholder="No device online"
          options={data.devices.map((d) => ({ value: d.id, label: d.status === "online" ? `${d.name}${d.activeJobs ? ` (${d.activeJobs}/${d.poolSize} busy)` : ""}` : `${d.name} (offline)` }))}
          onValueChange={setDeviceId}
        />
        {data.repositories.length > 1 && (
          <Select className="!w-auto" ariaLabel="Repository" value={repo.id} options={data.repositories.map((r) => ({ value: r.id, label: r.name }))} onValueChange={(v) => (setBase(null), setRepositoryId(v))} />
        )}
        <BaseBranchPicker issueRef={issueRef} repositoryId={repo.id} value={baseBranch} onChange={(b) => setBase(b ?? repo.defaultBranch)} />
        {models.length > 0 && (
          <span className="flex items-center gap-1">
            <ClaudeIcon />
            <Select className="!w-auto" ariaLabel="Model" value={chosenModel} options={models.map((m) => ({ value: m, label: m }))} onValueChange={setModel} />
          </span>
        )}
        <button type="button" className="btn btn-primary" disabled={busy || !device || !chosenModel} onClick={() => void start()}>
          Start
        </button>
      </div>
      {!device && <p className="text-xs text-muted">None of your devices is online. Start the daemon on one.</p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
    </div>
  );
}

/**
 * Which branch the run starts from: the repository's branches from GitHub, its default branch first and chosen until someone picks
 * another. When GitHub cannot list them, a text box with the default branch in it. (How runs choose their base will change; this is the
 * simple version.)
 */
export function BaseBranchPicker({ issueRef, repositoryId, value, onChange }: { issueRef: string; repositoryId: string; value: string | null; onChange: (v: string | null) => void }) {
  const { api } = useServices();
  const q = useQuery(runBranchesQuery(api, issueRef, repositoryId));
  if (!q.data) return null;
  const current = value ?? q.data.defaultBranch;
  if (!q.data.listed)
    return (
      <label className="flex items-center gap-1 text-muted">
        from
        <input className="input w-40 py-1.5 font-mono text-xs" aria-label="Start from branch" value={current} onChange={(e) => onChange(e.target.value.trim() || null)} />
      </label>
    );
  return (
    <span className="flex items-center gap-1 text-muted">
      from
      <Select
        className="!w-auto"
        ariaLabel="Start from branch"
        value={current}
        options={q.data.branches.map((b) => ({ value: b, label: b === q.data.defaultBranch ? `${b} (default)` : b }))}
        onValueChange={(v) => onChange(v === q.data.defaultBranch ? null : v)}
      />
    </span>
  );
}

/**
 * The one thing about a run worth seeing without opening it: a pull request, a note that a newer run took its branch, the device being
 * out of reach, or the error that stopped it.
 */
function RunHeadline({ job: j }: { job: JobView }) {
  if (j.result.supersededBy) return <span className="text-warn">A newer run took over this branch, so no pull request was opened.</span>;
  if (j.state === "unreachable") return <span className="text-muted">Cannot reach the device. The run is not lost: it carries on if the device comes back.</span>;
  if (j.result.pullRequest)
    return (
      <a href={j.result.pullRequest.url} target="_blank" rel="noreferrer" className="text-accent hover:underline" aria-label={`Pull request #${j.result.pullRequest.number}`}>
        #{j.result.pullRequest.number} ↗{j.pullRequest?.ciState && ` · CI ${j.pullRequest.ciState}`}{!!j.pullRequest?.failed.length && ` (${j.pullRequest.failed.join(", ")})`}
      </a>
    );
  const problem = j.result.pullRequestError ?? j.error;
  return problem ? <span className="text-danger">{problem}</span> : null;
}

/** The rest of a run's outcome, shown when its details are open. */
function RunStats({ job: j }: { job: JobView }) {
  const stats = j.result.diffStats;
  if (madeNoChanges(j))
    return (
      <span>
        Nothing was changed, so nothing was pushed
        {j.result.costUsd != null ? ` · ~$${j.result.costUsd.toFixed(2)}` : ""}
      </span>
    );
  if (j.state !== "succeeded") return null;
  return (
    <span>
      {j.result.pushed ? "Pushed" : "Not pushed"}
      {j.result.commit ? ` · ${j.result.commit.slice(0, 7)}` : ""}
      {stats?.files != null ? ` · ${stats.files} files, +${stats.insertions ?? 0} −${stats.deletions ?? 0}` : ""}
      {j.result.costUsd != null ? ` · ~$${j.result.costUsd.toFixed(2)}` : ""}
      {j.result.pullRequestSkipped ? <span className="block">{j.result.pullRequestSkipped}</span> : null}
    </span>
  );
}

/** The runs on this issue, newest first, as a plain list. Clicking a run's branch expands its log under it. */
function RunsTable({ jobs, issueRef, repositories }: { jobs: JobView[]; issueRef: string; repositories: IssueRuns["repositories"] }) {
  const [openId, setOpenId] = useState<string | null>(jobs.find((j) => isActive(j.state))?.id ?? null);
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-md border border-line text-sm" aria-label="Runs">
      {jobs.map((j) => (
        <RunRow key={j.id} job={j} issueRef={issueRef} fullName={repositories.find((r) => r.id === j.repositoryId)?.fullName ?? null} open={openId === j.id} onToggle={() => setOpenId((id) => (id === j.id ? null : j.id))} />
      ))}
    </ul>
  );
}

function RunRow({ job: j, issueRef, fullName, open, onToggle }: { job: JobView; issueRef: string; fullName: string | null; open: boolean; onToggle: () => void }) {
  const { api, queryClient } = useServices();
  const active = isActive(j.state);
  const status = runStatus(j);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(false);
  const [confirmLost, setConfirmLost] = useState(false);
  // Same device and model. Continue carries on from this run's branch (what it pushed, or its starting branch if it was stopped or lost before pushing); Start over makes a fresh branch from the same base.
  // Either way this run stays in the list as it was.
  const rerun = async (continueThis: boolean) => {
    setAgain(true);
    setError(null);
    try {
      await api.runs.start(
        issueRef,
        continueThis
          ? { deviceId: j.deviceId, model: j.model, continuesJobId: j.id }
          : { deviceId: j.deviceId, repositoryId: j.repositoryId ?? undefined, model: j.model, baseBranch: j.baseBranch ?? undefined },
      );
      await queryClient.invalidateQueries({ queryKey: issueRunsQuery(api, issueRef).queryKey });
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setAgain(false);
    }
  };
  const markLost = async () => {
    setError(null);
    try {
      await api.runs.markLost(j.id);
    } catch (e) {
      setError(describeFailure(e));
    }
    setConfirmLost(false);
    await queryClient.invalidateQueries({ queryKey: issueRunsQuery(api, issueRef).queryKey });
  };
  // A run that pushed has work to continue from; a stopped or lost run can also be picked up again, from its starting branch.
  const canContinue = !active && (j.result.pushed === true || j.state === "canceled" || j.state === "lost");
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className={clsx("chip shrink-0", TONE_STYLE[status.tone])}>{status.label}</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="min-w-0 flex-1 truncate rounded text-left font-mono outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/50"
          title={j.branch}
        >
          {j.branch}
        </button>
        {fullName && j.result.pushed && (
          <a href={`https://github.com/${fullName}/tree/${j.branch}`} target="_blank" rel="noreferrer" className="shrink-0 text-muted hover:text-fg" aria-label="Open the branch on GitHub" title="Open the branch on GitHub">
            <ExternalLinkIcon />
          </a>
        )}
        <span className="min-w-0 max-w-[40%] truncate">
          <RunHeadline job={j} />
        </span>
        {j.state === "unreachable" && !confirmLost && (
          <button type="button" className="btn btn-ghost shrink-0 py-0.5 text-xs" onClick={() => setConfirmLost(true)} title="Give up waiting for this run">
            Mark as lost
          </button>
        )}
        {active && !j.cancelRequested && (
          <button
            type="button"
            className="btn shrink-0 py-0.5 text-xs"
            onClick={async () => {
              setError(null);
              try {
                await api.runs.cancel(j.id);
              } catch (e) {
                setError(describeFailure(e));
              }
              await queryClient.invalidateQueries({ queryKey: issueRunsQuery(api, issueRef).queryKey });
            }}
          >
            Stop
          </button>
        )}
        <span className="shrink-0 text-muted">{timeAgo(j.createdAt)}</span>
        <button type="button" aria-expanded={open} aria-label="Details" onClick={onToggle} className="btn btn-ghost shrink-0 px-1 py-0.5">
          <ChevronRightIcon className={clsx("transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-danger" role="alert">{error}</p>}
      {confirmLost && (
            <div className="space-y-1.5 rounded border border-line bg-panel-2 p-2 text-xs">
              <p>If this machine is only offline, the run may still be going. Marking it lost lets you continue it; if you do, the old run is stopped when the machine comes back.</p>
              <div className="flex gap-1">
                <button type="button" className="btn py-0.5 text-xs" onClick={() => void markLost()}>
                  Mark as lost
                </button>
                <button type="button" className="btn btn-ghost py-0.5 text-xs" onClick={() => setConfirmLost(false)}>
                  Keep waiting
                </button>
              </div>
            </div>
      )}
      {open && (
        <div className="mt-2 space-y-2 border-t border-line pt-2">
          <div className="space-y-1 text-xs text-muted">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-text">{j.deviceName ?? "a device"}</span>
              <ModelLabel model={j.model} />
              {j.baseBranch && <span>{j.continuesJobId ? `continues an earlier run · into ${j.baseBranch}` : `from ${j.baseBranch}`}</span>}
            </div>
            {j.lastHeardAt && j.state === "unreachable" && <div>Last heard {timeAgo(j.lastHeardAt)}</div>}
            <RunStats job={j} />
            {!active && (
              <div className="flex gap-1 pt-1">
                {canContinue && (
                  <button type="button" className="btn py-0.5 text-xs" disabled={again} onClick={() => void rerun(true)} title="A new run on this branch, from what this run pushed">
                    Continue
                  </button>
                )}
                <button type="button" className="btn btn-ghost py-0.5 text-xs" disabled={again} onClick={() => void rerun(false)} title="A new run on a fresh branch from the same starting branch">
                  Start over
                </button>
              </div>
            )}
          </div>
          <RunLog id={j.id} active={active} />
        </div>
      )}
    </li>
  );
}

function RunLog({ id, active }: { id: string; active: boolean }) {
  const { api } = useServices();
  const query = useQuery({ ...runEventsQuery(api, id), refetchInterval: active ? 2_000 : false });
  const events = query.data?.events ?? [];
  if (query.isPending) return <p className="mt-2 text-xs text-muted">Loading…</p>;
  if (!events.length) return <p className="mt-2 text-xs text-muted">Nothing reported yet.</p>;
  return (
    <ol className="mt-2 max-h-72 space-y-0.5 overflow-y-auto rounded border border-line bg-bg p-2 font-mono text-[11px] leading-relaxed" aria-label="Run log">
      {events.map((e) => (
        <li key={e.seq} className={clsx(e.type === "error" && "text-danger", e.type === "tool" && "text-agent")}>
          <span className="text-muted">{new Date(e.at).toLocaleTimeString()} </span>
          {describeEvent(e)}
        </li>
      ))}
    </ol>
  );
}

/** One line for an event the daemon reported. Unknown types still show, by name. */
export function describeEvent(e: JobEvent): string {
  const d = e.data as Record<string, unknown>;
  const s = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
  switch (e.type) {
    case "phase":
      return `— ${s("phase")}${s("detail") ? `: ${s("detail")}` : ""}`;
    case "started":
      return `— agent started${s("model") ? ` (${s("model")})` : ""}`;
    case "text":
      return s("text");
    case "tool":
      return `${s("name")}${s("summary") ? ` ${s("summary")}` : ""}`;
    case "result":
      return `— finished: ${s("subtype") || "done"}${typeof d.numTurns === "number" ? `, ${d.numTurns} turns` : ""}`;
    case "error":
      return `error: ${s("message")}`;
    default:
      return `${e.type} ${JSON.stringify(d)}`;
  }
}
