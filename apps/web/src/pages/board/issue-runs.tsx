import { useState } from "react";
import { Link } from "react-router";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import type { IssueRuns, JobEvent, JobState, JobView } from "@wheelhouse/api-client";
import { timeAgo } from "@wheelhouse/core/lib/time";
import { ClaudeIcon } from "../../components/icons";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { issueRunsQuery, runBranchesQuery, runEventsQuery } from "../../lib/queries";
import { useServices } from "../../lib/services";

/** A model name with the Claude mark beside it, wherever one is named: the picker, a run's row. */
function ModelLabel({ model }: { model: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <ClaudeIcon /> {model}
    </span>
  );
}

const ACTIVE: JobState[] = ["offered", "accepted", "running"];

const STATE_STYLE: Record<JobState, string> = {
  offered: "bg-panel-2 text-muted",
  accepted: "bg-agent/15 text-agent",
  running: "bg-agent/15 text-agent",
  succeeded: "bg-ok/15 text-ok",
  failed: "bg-danger/15 text-danger",
  canceled: "bg-panel-2 text-muted",
  rejected: "bg-warn/15 text-warn",
  expired: "bg-panel-2 text-muted",
  lost: "bg-warn/15 text-warn",
};

const STATE_LABEL: Record<JobState, string> = {
  offered: "waiting for the device",
  accepted: "setting up",
  running: "running",
  succeeded: "done",
  failed: "failed",
  canceled: "canceled",
  rejected: "refused",
  expired: "not picked up",
  lost: "lost",
};

/**
 * Runs on a device: send the issue to an agent on one of your machines (the Wheelhouse daemon), and follow each run. A run works in a
 * worktree on its own branch and pushes it; the board itself is not changed by the agent yet.
 */
export function IssueRunsSection({ issueRef }: { issueRef: string }) {
  const { api } = useServices();
  const query = useQuery({ ...issueRunsQuery(api, issueRef), refetchInterval: (q) => (q.state.data?.jobs.some((j) => ACTIVE.includes(j.state)) ? 5_000 : false) });
  const data = query.data;
  if (!data) return null;
  return (
    <section aria-label="Runs on a device">
      <span className="label">Runs on a device</span>
      <div className="space-y-3">
        <RunForm issueRef={issueRef} data={data} />
        {data.jobs.length > 0 && <RunsTable jobs={data.jobs} issueRef={issueRef} />}
      </div>
    </section>
  );
}

function RunForm({ issueRef, data }: { issueRef: string; data: IssueRuns }) {
  const { api, queryClient } = useServices();
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
  const repo = data.repositories.find((r) => r.id === repositoryId) ?? data.repositories[0];

  const start = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      await api.runs.start(issueRef, { deviceId: device.id, repositoryId: repo.id, model: chosenModel, baseBranch: base ?? undefined });
      await queryClient.invalidateQueries({ queryKey: issueRunsQuery(api, issueRef).queryKey });
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
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
        <BaseBranchPicker issueRef={issueRef} repositoryId={repo.id} value={base} onChange={setBase} />
        {models.length > 0 && (
          <span className="flex items-center gap-1">
            <ClaudeIcon />
            <Select className="!w-auto" ariaLabel="Model" value={chosenModel} options={models.map((m) => ({ value: m, label: m }))} onValueChange={setModel} />
          </span>
        )}
        <button type="button" className="btn btn-primary" disabled={busy || !device || !chosenModel} onClick={() => void start()}>
          Run on device
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
function BaseBranchPicker({ issueRef, repositoryId, value, onChange }: { issueRef: string; repositoryId: string; value: string | null; onChange: (v: string | null) => void }) {
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

/** One line under the branch name: what landed (succeeded), or why not (failed, canceled, …). */
function RunSummary({ job: j }: { job: JobView }) {
  const stats = j.result.diffStats;
  if (j.state === "succeeded")
    return (
      <span className="text-muted">
        {j.result.pushed ? "Pushed" : "Not pushed"}
        {j.result.commit ? ` · ${j.result.commit.slice(0, 7)}` : ""}
        {stats?.files != null ? ` · ${stats.files} files, +${stats.insertions ?? 0} −${stats.deletions ?? 0}` : ""}
        {j.result.costUsd != null ? ` · ~$${j.result.costUsd.toFixed(2)}` : ""}
      </span>
    );
  if (j.error) return <span className="text-danger">{j.error}</span>;
  return null;
}

/** The runs on this issue, newest first: one row per run, click its branch to expand the log. */
function RunsTable({ jobs, issueRef }: { jobs: JobView[]; issueRef: string }) {
  const [openId, setOpenId] = useState<string | null>(jobs.find((j) => ACTIVE.includes(j.state))?.id ?? null);
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-panel-2/50 text-left text-xs text-muted">
            <th className="px-3 py-2 font-medium">Branch</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Device</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <RunRow key={j.id} job={j} issueRef={issueRef} open={openId === j.id} onToggle={() => setOpenId((id) => (id === j.id ? null : j.id))} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ job: j, issueRef, open, onToggle }: { job: JobView; issueRef: string; open: boolean; onToggle: () => void }) {
  const { api, queryClient } = useServices();
  const active = ACTIVE.includes(j.state);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <tr className="border-b border-line last:border-0 align-top">
        <td className="max-w-0 px-3 py-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="block max-w-full truncate rounded text-left font-mono text-xs outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/50"
            title={j.branch}
          >
            {j.branch}
          </button>
          {j.baseBranch && <div className="mt-0.5 truncate text-xs text-muted">from {j.baseBranch}</div>}
          <div className="mt-0.5">
            <RunSummary job={j} />
          </div>
          {error && <p className="mt-0.5 text-xs text-danger" role="alert">{error}</p>}
        </td>
        <td className="px-3 py-2">
          <span className={clsx("chip", STATE_STYLE[j.state])}>{j.cancelRequested && active ? "stopping" : STATE_LABEL[j.state]}</span>
        </td>
        <td className="px-3 py-2 whitespace-nowrap">{j.deviceName ?? "a device"}</td>
        <td className="px-3 py-2 whitespace-nowrap">
          <ModelLabel model={j.model} />
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-muted">{timeAgo(j.createdAt)}</td>
        <td className="px-3 py-2 text-right whitespace-nowrap">
          {active && !j.cancelRequested && (
            <button
              type="button"
              className="btn py-0.5 text-xs"
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
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line last:border-0">
          <td colSpan={6} className="bg-bg/40 px-3 py-2">
            <RunLog id={j.id} active={active} />
          </td>
        </tr>
      )}
    </>
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
