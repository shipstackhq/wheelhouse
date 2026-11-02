import { useParams } from "react-router";
import { Link } from "../../lib/workspace";
import { DashboardScopeProvider } from "../../lib/dashboard-scope";
import { useBoard } from "../../lib/queries";
import { DashboardRefresh } from "../dashboard/refresh";
import { TEAM_WIDGETS, SPAN_CLASS } from "../dashboard/registry";
import { Page } from "../../components/page";

/**
 * `/t/:key/overview`: the team's own dashboard, so the most important things about it are visible at a glance. It is the
 * workspace dashboard's widgets read for this one team, plus Focus. The team's event stream (opened by the team
 * layout) keeps it live; the 30 s tick is the safety net.
 */
export function TeamOverviewPage() {
  const { key = "" } = useParams();
  const board = useBoard(key);
  const name = board.data?.team.name;
  return (
    <DashboardScopeProvider value={key}>
      <Page title={`Overview${name ? ` of ${name}` : ""}`} hint="What matters most in this team right now. The workspace dashboard is on the home page." action={<Link to={`/t/${key}`} className="btn">Open the board</Link>}>
        <DashboardRefresh stream={false} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            {TEAM_WIDGETS.map(({ id, span, Component }) => (
              <div key={id} className={`${SPAN_CLASS[span]} flex flex-col`}>
                <Component />
              </div>
            ))}
          </div>
      </Page>
    </DashboardScopeProvider>
  );
}
