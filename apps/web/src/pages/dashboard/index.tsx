import { Link } from "react-router";
import { useMe } from "../../lib/session";
import { WIDGETS, SPAN_CLASS } from "./registry";
import { DashboardRefresh } from "./refresh";

/** The home page: how the workspace's projects are moving and what its agents are up to. Each widget loads on its own. */
export function Dashboard() {
  const me = useMe().data;
  if (!me) return null;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="h-full overflow-y-auto">
      <DashboardRefresh />
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">
              {greeting}, {me.user.name.split(" ")[0]}
            </h1>
            <p className="mt-1 text-sm text-muted">How {me.workspace.name}&apos;s projects are moving, and what the agents are up to.</p>
          </div>
          <Link to="/projects/new" className="btn">+ New project</Link>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {WIDGETS.map(({ id, span, Component }) => (
            <div key={id} className={`${SPAN_CLASS[span]} flex flex-col`}>
              <Component />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
