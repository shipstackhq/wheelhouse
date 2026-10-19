import { Link, useParams } from "react-router";
import { DashboardScopeProvider } from "../../lib/dashboard-scope";
import { useBoard } from "../../lib/queries";
import { DashboardRefresh } from "../dashboard/refresh";
import { PROJECT_WIDGETS, SPAN_CLASS } from "../dashboard/registry";

/**
 * `/p/:key/overview`: the project's own dashboard, so the most important things about it are visible at a glance. It is the
 * workspace dashboard's widgets read for this one project, plus Focus. The project's event stream (opened by the project
 * layout) keeps it live; the 30 s tick is the safety net.
 */
export function ProjectOverviewPage() {
  const { key = "" } = useParams();
  const board = useBoard(key);
  const name = board.data?.project.name;
  return (
    <DashboardScopeProvider value={key}>
      <div className="h-full overflow-y-auto">
        <DashboardRefresh stream={false} />
        <div className="mx-auto max-w-[1400px] px-6 py-6">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">Overview{name ? ` of ${name}` : ""}</h1>
              <p className="mt-1 text-sm text-muted">What matters most in this project right now. The workspace dashboard is on the home page.</p>
            </div>
            <Link to={`/p/${key}`} className="btn">Open the board</Link>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            {PROJECT_WIDGETS.map(({ id, span, Component }) => (
              <div key={id} className={`${SPAN_CLASS[span]} flex flex-col`}>
                <Component />
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardScopeProvider>
  );
}
