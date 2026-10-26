import { useState } from "react";
import { useSearchParams } from "react-router";
import { Link } from "../lib/workspace";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import type { DeviceStatus, DeviceView } from "@wheelhouse/api-client";
import { timeAgo } from "@wheelhouse/shared/time";
import { CopyBlock } from "../components/copy-block";
import { Loaded, errorText } from "../components/query-state";
import { Select, useDialogs } from "../components/ui";
import { describeFailure } from "../lib/form-state";
import { devicesQuery, useDevices } from "../lib/queries";
import { useServices } from "../lib/services";

/** The most runs a device takes at once; the server and the daemon hold the same limit. */
const MAX_POOL = 8;

export const STATUS_STYLE: Record<DeviceStatus, string> = {
  online: "bg-ok/15 text-ok",
  offline: "bg-panel-2 text-muted",
  revoked: "bg-danger/15 text-danger",
};

/** The command that pairs a machine with this Wheelhouse, run in a checkout of wheelhouse-cli until the daemon is published. */
const pairCommand = () => `node daemon/src/cli.mjs pair --server ${window.location.origin}`;

/**
 * `/settings/devices`: the person's machines that run agent jobs (the Wheelhouse daemon). A machine is paired from the machine itself; it
 * then shows here with what it can run, how many runs it takes at once, and a way to unpair it.
 */
export function DevicesSettingsPage() {
  const query = useDevices();
  return (
    <div className="w-full space-y-4 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Devices</h1>
        <p className="mt-1 text-sm text-muted">
          Your machines that run agents for Wheelhouse. A device uses its own Claude Code sign-in, which never leaves it; Wheelhouse only sends it work and
          shows what it reports back.
        </p>
      </div>
      <div className="card space-y-3 p-5">
        <h2 className="font-medium">Pair a machine</h2>
        <p className="text-sm text-muted">
          On the machine, with Claude Code installed and signed in, run this in a checkout of wheelhouse-cli. It prints a code; open the link it shows and
          approve it here.
        </p>
        <CopyBlock value={pairCommand()} />
      </div>
      <Loaded query={query} label="Loading devices" rows={2}>
        {(devices) =>
          devices.length === 0 ? (
            <p className="text-sm text-muted">No devices yet.</p>
          ) : (
            <ul className="space-y-3" aria-label="Devices">
              {devices.map((d) => (
                <DeviceCard key={d.id} device={d} />
              ))}
            </ul>
          )
        }
      </Loaded>
    </div>
  );
}

function DeviceCard({ device: d }: { device: DeviceView }) {
  const { api, queryClient } = useServices();
  const { confirm, prompt, dialogs } = useDialogs();
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      await queryClient.invalidateQueries({ queryKey: devicesQuery(api).queryKey });
    }
  };
  const claude = d.capabilities.claude;
  return (
    <li className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium">{d.name}</h2>
        <span className={clsx("chip", STATUS_STYLE[d.status])}>{d.status}</span>
        <span className="chip bg-panel-2 text-muted">{d.os}</span>
        {d.activeJobs > 0 && <span className="chip bg-agent/15 text-agent">{d.activeJobs} running</span>}
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[140px_1fr]">
        <dt className="text-muted">Claude Code</dt>
        <dd>
          {!claude ? (
            <span className="text-muted">Not reported yet</span>
          ) : !claude.installed ? (
            <span className="text-warn">Not installed</span>
          ) : !claude.signedIn ? (
            <span className="text-warn">Installed, not signed in</span>
          ) : (
            <span>
              Signed in{claude.subscriptionType ? ` (${claude.subscriptionType})` : ""}
              {claude.version ? <span className="text-muted"> · {claude.version}</span> : null}
            </span>
          )}
        </dd>
        <dt className="text-muted">Models</dt>
        <dd>{d.models.join(", ") || <span className="text-muted">none until Claude Code is installed and signed in</span>}</dd>
        <dt className="text-muted">Runs at once</dt>
        <dd className="max-w-[120px]">
          <Select
            ariaLabel="Runs at once"
            value={String(d.poolSize)}
            options={Array.from({ length: MAX_POOL }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
            onValueChange={(v) => void run(() => api.devices.update(d.id, { poolSize: Number(v) }))}
          />
        </dd>
        <dt className="text-muted">Last seen</dt>
        <dd>{d.lastSeenAt ? timeAgo(d.lastSeenAt) : "never"}{d.daemonVersion && <span className="text-muted"> · daemon {d.daemonVersion}</span>}</dd>
      </dl>
      {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const name = await prompt({ title: "Rename device", placeholder: d.name, confirmLabel: "Rename" });
            if (name) await run(() => api.devices.update(d.id, { name }));
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={async () => {
            const ok = await confirm({
              title: `Unpair ${d.name}?`,
              description: "It stops getting work at once, and any run on it is canceled. Branches it already pushed stay. To use it again, pair it again.",
              confirmLabel: "Unpair",
              danger: true,
            });
            if (ok) await run(() => api.devices.unpair(d.id));
          }}
        >
          Unpair
        </button>
      </div>
      {dialogs}
    </li>
  );
}

/**
 * `/devices/pair?code=...`: where the link the daemon prints lands. Shows the machine as it described itself, and the person approves it
 * as theirs (naming it as they like) or says it is not theirs.
 */
export function DevicePairPage() {
  const { api, queryClient } = useServices();
  const [params, setParams] = useSearchParams();
  const code = params.get("code") ?? "";
  const [typed, setTyped] = useState(code);
  const [name, setName] = useState<string | null>(null);
  const [state, setState] = useState<{ done?: "approved" | "denied"; error?: string; busy?: boolean }>({});
  const peek = useQuery({ queryKey: ["pairing", code], queryFn: () => api.devices.peekPairing(code), enabled: !!code, retry: false });

  const act = async (fn: () => Promise<unknown>, done: "approved" | "denied") => {
    setState({ busy: true });
    try {
      await fn();
      setState({ done });
      void queryClient.invalidateQueries({ queryKey: devicesQuery(api).queryKey });
    } catch (e) {
      setState({ error: describeFailure(e) });
    }
  };

  return (
    <div className="w-full max-w-lg space-y-4 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Pair a machine</h1>
        <p className="mt-1 text-sm text-muted">Approve only a machine you started pairing yourself: it will run agents for you, with your access.</p>
      </div>
      {!code ? (
        <form
          className="card flex gap-2 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) setParams({ code: typed.trim().toUpperCase() });
          }}
        >
          <input className="input font-mono uppercase" aria-label="Pairing code" placeholder="BCDF-GHJK" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button className="btn btn-primary shrink-0" disabled={!typed.trim()}>Continue</button>
        </form>
      ) : state.done === "approved" ? (
        <div className="card space-y-2 p-5">
          <p className="text-sm text-ok">Paired. The machine finishes setting up on its own and shows as online in a few seconds.</p>
          <Link className="btn" to="/settings/devices">Your devices</Link>
        </div>
      ) : state.done === "denied" ? (
        <div className="card p-5 text-sm">Refused. That machine cannot use this code again.</div>
      ) : peek.isPending ? (
        <div className="card p-5 text-sm text-muted">Looking up the code…</div>
      ) : peek.isError ? (
        <div className="card space-y-3 p-5" role="alert">
          <p className="text-sm text-danger">{errorText(peek.error)}</p>
          <button type="button" className="btn" onClick={() => setParams({})}>Enter another code</button>
        </div>
      ) : (
        <div className="card space-y-4 p-5">
          <dl className="grid grid-cols-[100px_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Code</dt>
            <dd className="font-mono">{peek.data.userCode}</dd>
            <dt className="text-muted">Machine</dt>
            <dd>{peek.data.name}</dd>
            <dt className="text-muted">System</dt>
            <dd>{peek.data.os}</dd>
          </dl>
          <label className="block text-sm">
            <span className="label">Call it</span>
            <input className="input" value={name ?? peek.data.name} onChange={(e) => setName(e.target.value)} />
          </label>
          {state.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" disabled={state.busy} onClick={() => void act(() => api.devices.approvePairing(code, (name ?? "").trim() || undefined), "approved")}>
              Approve
            </button>
            <button type="button" className="btn" disabled={state.busy} onClick={() => void act(() => api.devices.denyPairing(code), "denied")}>
              Not my machine
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
