import { Link } from "react-router";
import { ChevronRightIcon } from "../../components/icons";
import { INTEGRATIONS } from "./integrations";

/** `/settings/integrations`: the services Wheelhouse connects to, each with its own page. */
export function IntegrationsPage() {
  return (
    <div className="w-full space-y-4 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="mt-1 text-sm text-muted">The services your workspace connects to.</p>
      </div>
      <div className="card p-5">
        <ul className="divide-y divide-line text-sm">
          {INTEGRATIONS.map(({ icon: { line: Icon }, ...i }) => (
            <li key={i.id}>
              <Link to={i.to} className="flex items-center gap-3 py-3 hover:text-fg" aria-label={i.label}>
                <Icon className="shrink-0 text-xl" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{i.label}</span>
                  <span className="mt-0.5 block text-muted">{i.hint}</span>
                </span>
                <ChevronRightIcon aria-hidden className="text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
