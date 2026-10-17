import { Link } from "react-router";
import clsx from "clsx";
import type { UseQueryResult } from "@tanstack/react-query";
import { timeAgo } from "@wheelhouse/core/lib/time";
import { CollapsibleList } from "../../components/collapsible-list";
import { ActivityRow } from "../../components/dashboard/activity-row";
import { ColumnChart } from "../../components/dashboard/column-chart";
import { LimitedSection, SECTION_LIMIT, TwoLineRow } from "../../components/dashboard/limited-list";
import { StageBar, StageLegend } from "../../components/dashboard/stage-bar";
import { Empty, StatTile, Widget, WidgetSkeleton } from "../../components/dashboard/widget";
import { errorText } from "../../components/query-state";
import { List } from "../../components/list";
import { SessionRemoveButton } from "../../components/session-remove-button";
import { SessionGroups } from "../../components/session-row";
import { SubmitButton } from "../../components/submit-button";
import { Tip } from "../../components/tip";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useWidget } from "../../lib/queries";
import { AgentIcon, ArrowRightIcon, TrendUpIcon, WarningIcon } from "../../components/icons";

/**
 * Dashboard widgets. Each one reads its own data (GET /api/app/dashboard/:widget) and draws itself inside <Widget>, so a slow
 * widget never holds up the others: it shows its skeleton until its data is there, or says why it could not load.
 * To add one: add the metric and its endpoint, write the component here, register it in ./registry.tsx.
 */

/** A widget whose data failed to load: say so inside its own frame, with a way to try again. */
function Failed({ title, query }: { title: string; query: UseQueryResult }) {
  return (
    <Widget title={title}>
      <div role="alert" className="py-6 text-center text-sm">
        <p className="text-danger">{errorText(query.error)}</p>
        <button type="button" className="btn mt-3" onClick={() => void query.refetch()}>Try again</button>
      </div>
    </Widget>
  );
}

export function KpiRow() {
  const q = useWidget("kpis");
  if (q.isPending) return <WidgetSkeleton title="Key numbers" height={72} />;
  if (q.isError) return <Failed title="Key numbers" query={q} />;
  const s = q.data;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
      <StatTile label="Open tickets" value={s.open} hint={`across ${s.projects} project${s.projects === 1 ? "" : "s"}`} />
      <StatTile label="In progress" value={s.inProgress} hint={`${s.inReview} waiting for review`} />
      <StatTile
        label="Completed, last 7 days"
        value={s.completed7d}
        delta={{ value: s.completed7d - s.completedPrev7d, period: "prior 7 days", upIsGood: true }}
      />
      <StatTile
        label="Agent share of changes"
        value={s.agentShare7d === null ? "—" : `${Math.round(s.agentShare7d * 100)}%`}
        hint={`${s.events7d} changes in 7 days`}
      />
      <StatTile label="Stale map nodes" value={s.staleNodes} hint={`of ${s.mapNodes} described`} />
      <StatTile label="Stale docs" value={s.staleDocs} hint="possibly out of date" href="/" />
      <StatTile label="Agents connected" value={s.agents} hint="active API keys" href="/agents" />
    </div>
  );
}

export function ProjectProgress() {
  const q = useWidget("progress");
  if (q.isPending) return <WidgetSkeleton title="Project progress" height={220} />;
  if (q.isError) return <Failed title="Project progress" query={q} />;
  const ps = q.data;
  const names = ps.find((p) => p.stages.length)?.stages.map((s) => s.name) ?? [];
  return (
    <Widget title="Project progress" subtitle="Tickets per column; done = the last column" action={names.length ? <StageLegend names={names} /> : undefined}>
      {ps.length === 0 ? (
        <Empty>
          No projects yet. <Link className="text-accent" to="/projects/new">Create one</Link>.
        </Empty>
      ) : (
        <List inset="card" density="roomy">
          {ps.map((p) => (
            <li key={p.id}>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link to={`/p/${p.key}`} className="flex items-center gap-2 hover:text-accent">
                  <span className="chip bg-accent/15 font-mono text-accent">{p.key}</span>
                  <span className="font-medium">{p.name}</span>
                </Link>
                <span className="text-sm">
                  <b>{Math.round(p.pct * 100)}%</b> <span className="text-muted">done · {p.done}/{p.total}</span>
                </span>
                <span className="ml-auto flex flex-wrap gap-3 text-xs text-muted">
                  {p.urgent > 0 && <span className="text-danger"><TrendUpIcon /> {p.urgent} high/urgent</span>}
                  {p.agentReady > 0 && <span className="text-agent"><AgentIcon /> {p.agentReady} AI-ready</span>}
                  {p.staleNodes > 0 && (
                    <Link to={`/p/${p.key}/map`} className="text-warn hover:underline"><WarningIcon /> {p.staleNodes} stale</Link>
                  )}
                  {p.staleDocs > 0 && (
                    <Link to={`/p/${p.key}/docs`} className="text-warn hover:underline"><WarningIcon /> {p.staleDocs} stale doc{p.staleDocs === 1 ? "" : "s"}</Link>
                  )}
                  <span>{p.lastActivity ? `active ${timeAgo(p.lastActivity)}` : "no activity in 4 weeks"}</span>
                </span>
              </div>
              <StageBar stages={p.stages} />
            </li>
          ))}
        </List>
      )}
    </Widget>
  );
}

export function Throughput() {
  const q = useWidget("throughput");
  if (q.isPending) return <WidgetSkeleton title="Throughput" height={200} />;
  if (q.isError) return <Failed title="Throughput" query={q} />;
  return (
    <Widget title="Throughput" subtitle="Tickets created vs completed per day, last 14 days">
      <ColumnChart
        label="Tickets created and completed per day"
        data={q.data}
        series={[
          { key: "created", label: "Created", color: "var(--series-1)" },
          { key: "completed", label: "Completed", color: "var(--series-2)" },
        ]}
      />
    </Widget>
  );
}

export function ActivitySplit() {
  const q = useWidget("activity-split");
  if (q.isPending) return <WidgetSkeleton title="Who's doing the work" height={200} />;
  if (q.isError) return <Failed title="Who's doing the work" query={q} />;
  return (
    <Widget title="Who's doing the work" subtitle="All board and map changes per day, by teammates vs agents">
      <ColumnChart
        stacked
        label="Changes per day by teammates and agents"
        data={q.data}
        series={[
          { key: "human", label: "Teammates", color: "var(--series-1)" },
          { key: "agent", label: "Agents", color: "var(--series-2)" },
        ]}
      />
    </Widget>
  );
}

export function AgentQueues() {
  const { api, queryClient } = useServices();
  const q = useWidget("agents");
  if (q.isPending) return <WidgetSkeleton title="Agents" height={160} />;
  if (q.isError) return <Failed title="Agents" query={q} />;
  const agents = q.data;
  return (
    <Widget title="Agents" subtitle="Changes each agent hasn't picked up yet" action={<Link to="/agents" className="text-xs text-muted hover:text-fg">Manage <ArrowRightIcon /></Link>}>
      {agents.length === 0 ? (
        <Empty>
          No agents connected. <Link className="text-accent" to="/agents">Create an API key</Link>.
        </Empty>
      ) : (
        <List inset="card" className="text-sm">
          {agents.map((a) => (
            <li key={a.id} className="flex items-start gap-3">
              <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", a.pending ? "bg-agent" : "bg-ok")} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium"><AgentIcon /> {a.name}</div>
                <Tip
                  content={
                    <div className="space-y-0.5">
                      <div>{a.lastUsedAt ? `Last used ${timeAgo(a.lastUsedAt)}` : "Never connected"}</div>
                      <div>
                        {a.actions7d} change{a.actions7d === 1 ? "" : "s"} in the last 7 days
                      </div>
                    </div>
                  }
                >
                  <div tabIndex={0} className="w-fit rounded text-xs text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/60">
                    {a.lastUsedAt ? `seen ${timeAgo(a.lastUsedAt)}` : "never connected"}
                    {a.sessions.length > 0 && ` · ${a.sessions.length} session${a.sessions.length === 1 ? "" : "s"}`}
                  </div>
                </Tip>
                <SessionGroups sessions={a.sessions} action={(x) => <SessionRemoveButton projectKey={x.projectKey ?? ""} sessionId={x.id} />} />
              </div>
              <div className="text-right text-xs">
                {a.pending ? (
                  <>
                    <Tip
                      side="left"
                      align="center"
                      content={
                        <div className="space-y-0.5">
                          {a.byProject.map((p) => (
                            <div key={p.key} className="flex justify-between gap-4">
                              <span>{p.key}</span>
                              <span className="tabular-nums">{p.pending} queued</span>
                            </div>
                          ))}
                        </div>
                      }
                    >
                      <div tabIndex={0} className="rounded font-medium outline-none focus-visible:ring-1 focus-visible:ring-accent/60">
                        {a.pending} queued
                      </div>
                    </Tip>
                    <form
                      action={async () => {
                        await api.agents.markAllSeen({ keyId: a.id });
                        await refreshAll(queryClient);
                      }}
                    >
                      <SubmitButton className="mt-0.5 text-muted underline-offset-2 hover:text-fg hover:underline" title="Reset this agent's queue">
                        mark all seen
                      </SubmitButton>
                    </form>
                  </>
                ) : (
                  <span className="text-muted">in sync</span>
                )}
              </div>
            </li>
          ))}
        </List>
      )}
    </Widget>
  );
}

function AttentionSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div>
      <div className="label">
        {title} <span className="normal-case text-muted/70">({count})</span>
      </div>
      <List inset="card" className="text-sm">{children}</List>
    </div>
  );
}

export function NeedsAttention() {
  const q = useWidget("attention");
  if (q.isPending) return <WidgetSkeleton title="Needs attention" height={220} />;
  if (q.isError) return <Failed title="Needs attention" query={q} />;
  const a = q.data;
  const empty = !a.review.length && !a.urgent.length && !a.stale.length && !a.staleDocs.length;
  return (
    <Widget title="Needs attention" subtitle="Where a human is the bottleneck">
      {empty ? (
        <Empty>Nothing waiting on you.</Empty>
      ) : (
        <div className="space-y-4">
          <AttentionSection title="Waiting for review" count={a.review.length}>
            {a.review.map((t) => (
              <li key={t.ref}>
                <Link to={`/p/${t.projectKey}?t=${t.ref}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
                  <span className="shrink-0 font-mono text-xs text-muted">{t.ref}</span>
                  <span className="truncate">{t.title}</span>
                  {t.byAgent && <span className="ml-auto shrink-0 text-xs text-agent" title="Agent work"><AgentIcon /></span>}
                </Link>
              </li>
            ))}
          </AttentionSection>
          <AttentionSection title="Urgent" count={a.urgent.length}>
            {a.urgent.map((t) => (
              <li key={t.ref}>
                <Link to={`/p/${t.projectKey}?t=${t.ref}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
                  <span className="shrink-0 font-mono text-xs text-muted">{t.ref}</span>
                  <span className="truncate">{t.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted">{t.column}</span>
                </Link>
              </li>
            ))}
          </AttentionSection>
          <AttentionSection title="Stale explanations" count={a.stale.length}>
            {a.stale.map((n) => (
              <li key={n.id}>
                <Link to={`/p/${n.projectKey}/map?node=${n.id}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2" title={n.reason ?? undefined}>
                  <span className="shrink-0 text-xs text-warn"><WarningIcon /></span>
                  <span className="truncate">{n.name}</span>
                  <span className="ml-auto shrink-0 text-xs uppercase text-muted">
                    {n.projectKey} · {n.layer}
                  </span>
                </Link>
              </li>
            ))}
          </AttentionSection>
          <AttentionSection title="Stale docs" count={a.staleDocs.length}>
            {a.staleDocs.map((d) => (
              <li key={d.id}>
                <Link to={`/p/${d.projectKey}/docs?doc=${d.id}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2" title={d.reason ?? undefined}>
                  <span className="shrink-0 text-xs text-warn"><WarningIcon /></span>
                  <span className="truncate">{d.title}</span>
                  <span className="ml-auto shrink-0 text-xs uppercase text-muted">{d.projectKey}</span>
                </Link>
              </li>
            ))}
          </AttentionSection>
        </div>
      )}
    </Widget>
  );
}

export function RecentActivity() {
  const q = useWidget("recent");
  if (q.isPending) return <WidgetSkeleton title="Recent activity" height={160} />;
  if (q.isError) return <Failed title="Recent activity" query={q} />;
  return (
    <Widget title="Recent activity" subtitle="Across all projects">
      {q.data.length === 0 ? (
        <Empty>Nothing in the last 4 weeks.</Empty>
      ) : (
        <CollapsibleList limit={SECTION_LIMIT} title="Recent activity">
          {q.data.map((e) => (
            <ActivityRow key={e.seq} e={e} />
          ))}
        </CollapsibleList>
      )}
    </Widget>
  );
}

export function SyncHealth() {
  const q = useWidget("sync");
  if (q.isPending) return <WidgetSkeleton title="Sync health" height={160} />;
  if (q.isError) return <Failed title="Sync health" query={q} />;
  const h = q.data;
  const empty = !h.untracked.length && !h.quiet.length && !h.drafts.length;
  return (
    <Widget title="Sync health" subtitle="Where the board and map are drifting from real work">
      {empty ? (
        <Empty>Board and map match the work in flight.</Empty>
      ) : (
        <div className="space-y-6">
          <LimitedSection
            title="Work not linked to a ticket"
            items={h.untracked}
            row={(u) => (
              <TwoLineRow
                key={u.id}
                lead={u.projectKey}
                title={`${u.files.slice(0, 2).join(", ")}${u.files.length > 2 ? ` +${u.files.length - 2}` : ""}`}
                meta={`${u.by} · ${timeAgo(u.since)}`}
                tip={
                  <div className="space-y-0.5">
                    <div>
                      {u.by} changed {u.files.length} file{u.files.length === 1 ? "" : "s"} {timeAgo(u.since)}, with no ticket on the session
                    </div>
                    <div className="font-mono text-[11px] text-muted">
                      {u.files.slice(0, 8).map((f) => (
                        <div key={f}>{f}</div>
                      ))}
                      {u.files.length > 8 && <div>+{u.files.length - 8} more</div>}
                    </div>
                  </div>
                }
              />
            )}
          />
          <LimitedSection
            title="Agent went quiet"
            items={h.quiet}
            row={(x) => (
              <TwoLineRow
                key={x.ref}
                href={`/p/${x.projectKey}?t=${x.ref}`}
                lead={x.ref}
                title={x.title}
                meta={
                  <>
                    <AgentIcon /> {x.agent} · {timeAgo(x.lastAt)}
                  </>
                }
                tip={
                  <div className="space-y-0.5">
                    <div className="font-medium">
                      {x.ref} {x.title}
                    </div>
                    <div className="text-muted">
                      Claimed by {x.agent}; its last activity on it was {timeAgo(x.lastAt)}
                    </div>
                  </div>
                }
              />
            )}
          />
          <LimitedSection
            title="Map drafts waiting to land"
            items={h.drafts}
            row={(d) => (
              <TwoLineRow
                key={d.id}
                href={`/p/${d.projectKey}/map?node=${d.nodeId}`}
                title={d.node}
                meta={`${d.confirm ? "confirmation" : "update"} · ${d.authorName} · ${timeAgo(d.createdAt)}`}
                tip={
                  <div className="space-y-0.5">
                    <div className="font-medium">{d.node}</div>
                    <div className="text-muted">
                      {d.confirm ? "A confirmation that it is still accurate" : "An updated description"} by {d.authorName}, {timeAgo(d.createdAt)}. It publishes when the code lands.
                    </div>
                  </div>
                }
              />
            )}
          />
        </div>
      )}
    </Widget>
  );
}
