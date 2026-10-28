import { useState } from "react";
import { Link } from "../../lib/workspace";
import { integrationPath, INTEGRATIONS, type Integration } from "./integrations";
import { StateBadge } from "./integration-page";

type Filter = "all" | "enabled";

/** `/settings/integrations`: the store. Search, an All/Enabled filter and a card per integration that opens its page. */
export function IntegrationsPage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <div className="w-full space-y-4 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">All integrations</h1>
        <p className="mt-1 text-sm text-muted">Find an integration, see which are on, and set each one up.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input className="input max-w-xs flex-1" type="search" placeholder="Search integrations" aria-label="Search integrations" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div role="group" aria-label="Filter" className="flex gap-1">
          {(["all", "enabled"] as const).map((f) => (
            <button key={f} type="button" className={filter === f ? "btn btn-primary" : "btn"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : "Enabled"}
            </button>
          ))}
        </div>
      </div>
      <Grid query={query} filter={filter} />
    </div>
  );
}

/** Whether an integration matches the search: its name, category or what it does. */
export function matchesSearch(i: Integration, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [i.name, i.category, i.summary, ...i.whatItDoes].some((t) => t.toLowerCase().includes(q));
}

function Grid({ query, filter }: { query: string; filter: Filter }) {
  const shown = INTEGRATIONS.filter((i) => matchesSearch(i, query));
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {shown.map((i) => (
        <Card key={i.id} integration={i} filter={filter} />
      ))}
      {shown.length === 0 && <li className="col-span-full py-6 text-sm text-muted">No integrations match.</li>}
    </ul>
  );
}

/** One card. It reads its own state, so the Enabled filter hides it here when it is not on. */
function Card({ integration: i, filter }: { integration: Integration; filter: Filter }) {
  const { state } = i.useRuntime();
  const on = state === "enabled" || state === "attention";
  if (filter === "enabled" && !on) return null;
  const Icon = i.icon.line;
  return (
    <li>
      <Link to={integrationPath(i.id)} aria-label={i.name} className="card flex h-full flex-col gap-2 p-4 hover:border-accent/40">
        <div className="flex items-start gap-3">
          <Icon aria-hidden className="shrink-0 text-2xl" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{i.name}</div>
            <div className="text-xs text-muted">{i.category}</div>
          </div>
          {state !== "not_enabled" && <StateBadge state={state} />}
        </div>
        <p className="text-sm text-muted">{i.summary}</p>
      </Link>
    </li>
  );
}
