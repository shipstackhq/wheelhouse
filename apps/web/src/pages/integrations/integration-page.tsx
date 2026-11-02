import { useState, useTransition } from "react";
import { useParams } from "react-router";
import { Link } from "../../lib/workspace";
import { useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { findIntegration, type Integration, type IntegrationRuntime, type IntegrationState } from "./integrations";

export const STATE_LABEL: Record<IntegrationState, string> = { loading: "", not_enabled: "Not enabled", enabled: "Enabled", attention: "Needs attention" };

export function StateBadge({ state }: { state: IntegrationState }) {
  if (state === "loading") return null;
  const tone = state === "enabled" ? "bg-ok/15 text-ok" : state === "attention" ? "bg-warn/15 text-warn" : "bg-panel-2 text-muted";
  return <span className={`chip ${tone}`}>{STATE_LABEL[state]}</span>;
}

/** `/settings/integrations/:id`: one integration, every one in the same layout. Enabled: settings first, details folded. Not enabled: details first, settings hidden. */
export function IntegrationPage() {
  const integration = findIntegration(useParams().id);
  if (!integration) {
    return (
      <div className="w-full px-6 py-10">
        <p className="text-sm text-muted">
          There is no such integration. <Link to="/settings/integrations" className="underline hover:text-fg">See all integrations</Link>.
        </p>
      </div>
    );
  }
  return <Page integration={integration} />;
}

function Page({ integration }: { integration: Integration }) {
  const runtime = integration.useRuntime();
  const on = runtime.state === "enabled" || runtime.state === "attention";
  const [open, setOpen] = useState(false);
  const { Settings } = integration;
  const Icon = integration.icon.fill;
  return (
    <div className="w-full space-y-6 px-6 py-10">
      <p className="text-xs text-muted">
        <Link to="/settings/integrations" className="hover:text-fg">
          All integrations
        </Link>
      </p>
      {/* A dummy banner, as a store page has: a soft gradient with the integration's logo large and faint. */}
      <div aria-hidden className="grid h-40 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-accent/25 via-accent/10 to-panel-2 sm:h-52">
        <Icon className="text-8xl text-fg/20" />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="grid size-16 shrink-0 place-items-center rounded-2xl border border-line bg-panel">
          <Icon aria-hidden className="text-4xl" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{integration.name}</h1>
            <StateBadge state={runtime.state} />
          </div>
          <p className="text-sm text-muted">
            {integration.category} · {integration.maker}
          </p>
          <p className="mt-1 text-sm">{integration.summary}</p>
        </div>
        <div className="flex items-center gap-2">
          {on && (
            <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
              Details
            </button>
          )}
          <Actions integration={integration} runtime={runtime} />
        </div>
      </div>
      {runtime.note && <p className={on ? "text-sm text-warn" : "text-sm text-muted"}>{runtime.note}</p>}
      {on ? (
        <>
          {open && (
            <div className="card p-5">
              <DetailBody integration={integration} />
            </div>
          )}
          <Settings />
        </>
      ) : (
        <>
          <div className="card p-5">
            <DetailBody integration={integration} />
          </div>
          {runtime.state !== "loading" && <p className="text-sm text-muted">Settings appear here once {integration.name} is enabled.</p>}
        </>
      )}
    </div>
  );
}

function DetailBody({ integration: i }: { integration: Integration }) {
  return (
    <dl className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-x-8 gap-y-1">
        <div>
          <dt className="text-xs text-muted">Made by</dt>
          <dd>{i.maker}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Category</dt>
          <dd>{i.category}</dd>
        </div>
      </div>
      <Section title="What it does" items={i.whatItDoes} />
      <Section title="What it needs" items={i.whatItNeeds} />
      <div>
        <dt className="text-xs text-muted">Links</dt>
        <dd className="flex flex-wrap gap-4">
          {i.links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="underline hover:text-fg">
              {l.label}
            </a>
          ))}
        </dd>
      </div>
    </dl>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <dt className="text-xs text-muted">{title}</dt>
      <dd>
        <ul className="list-disc space-y-0.5 pl-5">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

/** Enable starts the integration's own set-up (a full page load); Disable asks first. Nothing shows when this person can do neither. */
function Actions({ integration, runtime }: { integration: Integration; runtime: IntegrationRuntime }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialogs } = useDialogs();
  const on = runtime.state === "enabled" || runtime.state === "attention";
  return (
    <div className="flex flex-col items-end gap-1">
      {!on && runtime.enableHref && (
        <a className="btn btn-primary" href={runtime.enableHref}>
          Enable
        </a>
      )}
      {on && runtime.disable && (
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={async () => {
            if (!(await confirm({ title: `Disable ${integration.name}?`, confirmLabel: "Disable", danger: true }))) return;
            start(async () => {
              try {
                await runtime.disable!();
                setError(null);
              } catch (e) {
                setError(describeFailure(e));
              }
            });
          }}
        >
          Disable
        </button>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {dialogs}
    </div>
  );
}
