import { useState } from "react";
import { useSearchParams } from "react-router";
import { Link } from "../lib/workspace";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import type { DeviceStatus, DeviceView } from "@wheelhouse/api-client";
import { timeAgo } from "@wheelhouse/shared/time";
import { CopyBlock } from "../components/copy-block";
import { NAV_ICONS } from "../components/icons";
import { Loaded, errorText } from "../components/query-state";
import { SETTINGS_ROW_PAD, SettingsList, SettingsRow } from "../components/settings-list";
import { Select, useDialogs } from "../components/ui";
import { describeFailure } from "../lib/form-state";
import { devicesQuery, runDefaultsQuery, useDevices } from "../lib/queries";
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
      <div className="pb-4">
        <h1 className="text-xl font-semibold">Devices</h1>
        <p className="mt-1 text-sm text-muted">
          Your machines that run agents for Wheelhouse. A device uses its own Claude Code sign-in, which never leaves it; Wheelhouse only sends it work and
          shows what it reports back.
        </p>
      </div>
      <SettingsList
        title="Pair a machine"
        hint="On the machine, with Claude Code installed and signed in, run this in a checkout of wheelhouse-cli. It prints a code; open the link it shows and approve it here."
      >
        <div className={SETTINGS_ROW_PAD}>
          <CopyBlock value={pairCommand()} />
        </div>
      </SettingsList>
      <RunDefaultsCard devices={query.data ?? []} />
      <Loaded query={query} label="Loading devices" rows={2}>
        {(devices) => (
          <SettingsList title="Connected devices">
            {devices.length === 0 ? <p className={`text-sm text-muted ${SETTINGS_ROW_PAD}`}>No devices yet.</p> : devices.map((d) => <DeviceRow key={d.id} device={d} />)}
          </SettingsList>
        )}
      </Loaded>
    </div>
  );
}

/**
 * Your own defaults for runs started in your name (WH-123): the lowest level, under a choice for the run and under what the agent's
 * profile sets. A default device that is offline is passed over for another online one, and the run's plan says so.
 */
function RunDefaultsCard({ devices }: { devices: DeviceView[] }) {
  const { api, queryClient } = useServices();
  const query = useQuery(runDefaultsQuery(api));
  const [error, setError] = useState<string | null>(null);
  const d = query.data;
  if (!d || devices.length === 0) return null;
  const models = [...new Set(devices.flatMap((x) => x.models))];
  const save = async (patch: Partial<typeof d>) => {
    setError(null);
    try {
      queryClient.setQueryData(runDefaultsQuery(api).queryKey, await api.devices.setRunDefaults(patch));
    } catch (e) {
      setError(describeFailure(e));
    }
  };
  const NONE = "";
  return (
    <SettingsList title="Run defaults" hint="Used for runs in your name when nothing says otherwise: the run itself, then the agent's own settings, come first.">
      <SettingsRow label="Default device">
        <Select className="!w-auto" ariaLabel="Default device" value={d.deviceId ?? NONE} options={[{ value: NONE, label: "No default device" }, ...devices.map((x) => ({ value: x.id, label: x.name }))]} onValueChange={(v) => void save({ deviceId: v || null })} />
      </SettingsRow>
      <SettingsRow label="Default model">
        <Select className="!w-auto" ariaLabel="Default model" value={d.model ?? NONE} options={[{ value: NONE, label: "No default model" }, ...models.map((m) => ({ value: m, label: m }))]} onValueChange={(v) => void save({ model: v || null })} />
      </SettingsRow>
      <SettingsRow label="Default effort">
        <Select className="!w-auto" ariaLabel="Default effort" value={d.effort ?? NONE} options={[{ value: NONE, label: "Claude's own effort" }, ...(["low", "medium", "high"] as const).map((e) => ({ value: e, label: `${e} effort` }))]} onValueChange={(v) => void save({ effort: (v || null) as typeof d.effort })} />
      </SettingsRow>
      {error && <p className={`text-sm text-danger ${SETTINGS_ROW_PAD}`} role="alert">{error}</p>}
    </SettingsList>
  );
}

/** One connected device, as a row of the Devices list: who it is and what state it is in; its Settings button opens the details and the ways to change it. */
function DeviceRow({ device: d }: { device: DeviceView }) {
  const { api, queryClient } = useServices();
  const { confirm, prompt, dialogs } = useDialogs();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
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
    <>
      <div className={`flex flex-wrap items-center justify-between gap-3 ${SETTINGS_ROW_PAD}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{d.name}</h3>
          <span className={clsx("chip", STATUS_STYLE[d.status])}>{d.status}</span>
          <span className="chip bg-panel-2 text-muted">{d.os}</span>
          {d.activeJobs > 0 && <span className="chip bg-agent/15 text-agent">{d.activeJobs} running</span>}
        </div>
        <button
          type="button"
          aria-label="Settings"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="rounded text-lg text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 aria-expanded:text-fg"
        >
          <NAV_ICONS.settings.line aria-hidden />
        </button>
        {dialogs}
      </div>
      {open && (
        <>
          <SettingsRow label="Claude Code">
            {!claude ? (
              "Not reported yet"
            ) : !claude.installed ? (
              <span className="text-warn">Not installed</span>
            ) : !claude.signedIn ? (
              <span className="text-warn">Installed, not signed in</span>
            ) : (
              <span>
                <span className="text-fg">Signed in{claude.subscriptionType ? ` (${claude.subscriptionType})` : ""}</span>
                {claude.version ? ` · ${claude.version}` : null}
              </span>
            )}
          </SettingsRow>
          <SettingsRow label="Models">{d.models.join(", ") || "none until Claude Code is installed and signed in"}</SettingsRow>
          <SettingsRow label="Runs at once">
            <Select
              className="!w-auto"
              ariaLabel="Runs at once"
              value={String(d.poolSize)}
              options={Array.from({ length: MAX_POOL }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
              onValueChange={(v) => void run(() => api.devices.update(d.id, { poolSize: Number(v) }))}
            />
          </SettingsRow>
          <SettingsRow label="Last seen">
            {d.lastSeenAt ? timeAgo(d.lastSeenAt) : "never"}
            {d.daemonVersion && ` · daemon ${d.daemonVersion}`}
          </SettingsRow>
          <div className={`flex flex-wrap items-center justify-between gap-3 ${SETTINGS_ROW_PAD}`}>
            <p className="min-w-0 text-sm text-danger" role={error ? "alert" : undefined}>{error}</p>
            <div className="flex gap-2">
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
          </div>
        </>
      )}
    </>
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
      <div className="pb-4">
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
