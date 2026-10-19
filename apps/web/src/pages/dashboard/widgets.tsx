import { useState } from "react";
import { Popover } from "radix-ui";
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
import { useDashboardTeam } from "../../lib/dashboard-scope";
import { useWidget } from "../../lib/queries";
import { AgentIcon, ArrowRightIcon, FilterIcon, SearchIcon, TrendUpIcon, WarningIcon } from "../../components/icons";

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
  const team = useDashboardTeam();
  if (q.isPending) return <WidgetSkeleton title="Key numbers" height={72} />;
  if (q.isError) return <Failed title="Key numbers" query={q} />;
  const s = q.data;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
      <StatTile label="Open tickets" value={s.open} hint={team ? "in this team" : `across ${s.teams} team${s.teams === 1 ? "" : "s"}`} />
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
      <StatTile label="Stale map nodes" value={s.staleNodes} hint={`of ${s.mapNodes} described`} href={team ? `/t/${team}/map` : undefined} />
      <StatTile label="Stale docs" value={s.staleDocs} hint="possibly out of date" href={team ? `/t/${team}/docs` : "/"} />
      {team ? (
        <StatTile label="Agents active" value={s.agentsActive7d} hint="changed something in 7 days" />
      ) : (
        <StatTile label="Agents connected" value={s.agents} hint="active API keys" href="/agents" />
      )}
    </div>
  );
}

export function TeamProgress() {
  const q = useWidget("progress");
  const team = useDashboardTeam();
  if (q.isPending) return <WidgetSkeleton title="Team progress" height={220} />;
  if (q.isError) return <Failed title="Team progress" query={q} />;
  const ps = q.data;
  const names = ps.find((p) => p.stages.length)?.stages.map((s) => s.name) ?? [];
  return (
    <Widget title="Team progress" subtitle="Tickets per column; done = the last column" action={names.length ? <StageLegend names={names} /> : undefined}>
      {ps.length === 0 ? (
        <Empty>
          You are not in any team yet. <Link className="text-accent" to="/teams/new">Create one</Link>, or ask a team admin to add you.
        </Empty>
      ) : (
        <List inset="card" density="roomy">
          {ps.map((p) => (
            <li key={p.id}>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link to={`/t/${p.key}`} className="flex items-center gap-2 hover:text-accent">
                  <span className="chip bg-accent/15 font-mono text-accent">{p.key}</span>
                  <span className="font-medium">{p.name}</span>
                </Link>
                {!team && (
                  <Link to={`/t/${p.key}/overview`} className="text-xs text-muted hover:text-accent" aria-label={`Overview of ${p.name}`}>
                    Overview <ArrowRightIcon />
                  </Link>
                )}
                <span className="text-sm">
                  <b>{Math.round(p.pct * 100)}%</b> <span className="text-muted">done · {p.done}/{p.total}</span>
                </span>
                <span className="ml-auto flex flex-wrap gap-3 text-xs text-muted">
                  {p.urgent > 0 && <span className="text-danger"><TrendUpIcon /> {p.urgent} high/urgent</span>}
                  {p.agentReady > 0 && <span className="text-agent"><AgentIcon /> {p.agentReady} AI-ready</span>}
                  {p.staleNodes > 0 && (
                    <Link to={`/t/${p.key}/map`} className="text-warn hover:underline"><WarningIcon /> {p.staleNodes} stale</Link>
                  )}
                  {p.staleDocs > 0 && (
                    <Link to={`/t/${p.key}/docs`} className="text-warn hover:underline"><WarningIcon /> {p.staleDocs} stale doc{p.staleDocs === 1 ? "" : "s"}</Link>
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
                <SessionGroups sessions={a.sessions} action={(x) => <SessionRemoveButton teamKey={x.teamKey ?? ""} sessionId={x.id} />} />
              </div>
              <div className="text-right text-xs">
                {a.pending ? (
                  <>
                    <Tip
                      side="left"
                      align="center"
                      content={
                        <div className="space-y-0.5">
                          {a.byTeam.map((p) => (
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

type AttentionKind = "review" | "urgent" | "stale" | "staleDocs";
type AttentionItem = { key: string; kind: AttentionKind; to: string; text: string; ref?: string; meta?: string; title?: string; byAgent?: boolean };

/** Every kind of thing waiting on a human, with the label its rows carry and the colour of that label. */
const ATTENTION_LABELS: { kind: AttentionKind; label: string; chip: string }[] = [
  { kind: "review", label: "Review", chip: "bg-accent/15 text-accent" },
  { kind: "urgent", label: "Urgent", chip: "bg-danger/15 text-danger" },
  { kind: "stale", label: "Stale explanation", chip: "bg-warn/15 text-warn" },
  { kind: "staleDocs", label: "Stale doc", chip: "bg-warn/15 text-warn" },
];

export function NeedsAttention() {
  const q = useWidget("attention");
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<AttentionKind[]>([]);
  if (q.isPending) return <WidgetSkeleton title="Needs attention" height={220} />;
  if (q.isError) return <Failed title="Needs attention" query={q} />;
  const a = q.data;
  const items: AttentionItem[] = [
    ...a.review.map((t) => ({ key: `r-${t.ref}`, kind: "review" as const, to: `/t/${t.teamKey}?t=${t.ref}`, ref: t.ref, text: t.title, byAgent: t.byAgent })),
    ...a.urgent.map((t) => ({ key: `u-${t.ref}`, kind: "urgent" as const, to: `/t/${t.teamKey}?t=${t.ref}`, ref: t.ref, text: t.title, meta: t.column })),
    ...a.stale.map((n) => ({ key: `n-${n.id}`, kind: "stale" as const, to: `/t/${n.teamKey}/map?node=${n.id}`, text: n.name, meta: `${n.teamKey} · ${n.layer}`, title: n.reason ?? undefined })),
    ...a.staleDocs.map((d) => ({ key: `d-${d.id}`, kind: "staleDocs" as const, to: `/t/${d.teamKey}/docs?doc=${d.id}`, text: d.title, meta: d.teamKey, title: d.reason ?? undefined })),
  ];
  const term = search.trim().toLowerCase();
  const shown = items.filter(
    (i) => !hidden.includes(i.kind) && (!term || `${i.ref ?? ""} ${i.text} ${i.meta ?? ""} ${labelOf(i.kind).label}`.toLowerCase().includes(term)),
  );
  const toggle = (kind: AttentionKind) => setHidden((h) => (h.includes(kind) ? h.filter((k) => k !== kind) : [...h, kind]));
  return (
    <Widget title="Needs attention" subtitle="Where a human is the bottleneck">
      {items.length === 0 ? (
        <Empty>Nothing waiting on you.</Empty>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                type="search"
                className="input !rounded-full !border-transparent !bg-panel-2/70 !py-1.5 !pr-8 text-sm focus:!border-accent"
                placeholder="Search…"
                aria-label="Search what needs attention"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <SearchIcon className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base text-muted" />
            </div>
            <Popover.Root>
              <Popover.Trigger className="btn shrink-0 gap-1.5" aria-label="Filter by label">
                <FilterIcon />
                {hidden.length > 0 && <span className="text-xs text-accent">{ATTENTION_LABELS.length - hidden.length}/{ATTENTION_LABELS.length}</span>}
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content align="end" sideOffset={6} collisionPadding={8} className="z-50 w-56 rounded-lg border border-line bg-panel p-2 text-sm text-fg shadow-xl">
                  <div className="label px-1">Show</div>
                  {ATTENTION_LABELS.map(({ kind, label, chip }) => {
                    const count = items.filter((i) => i.kind === kind).length;
                    return (
                      <label key={kind} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 hover:bg-panel-2">
                        <input type="checkbox" checked={!hidden.includes(kind)} onChange={() => toggle(kind)} />
                        <span className={clsx("chip", chip)}>{label}</span>
                        <span className="ml-auto text-xs text-muted">{count}</span>
                      </label>
                    );
                  })}
                  {hidden.length > 0 && (
                    <button type="button" className="mt-1 w-full rounded px-1 py-1.5 text-left text-xs text-accent hover:bg-panel-2" onClick={() => setHidden([])}>
                      Show all
                    </button>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          {shown.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nothing matches.</p>
          ) : (
            <div className="-mx-4 min-h-[12.5rem] max-h-[25rem] overflow-y-auto" data-testid="attention-list">
            <List inset="flush" className="text-sm">
              {shown.map((i) => (
                <li key={i.key}>
                  <Link to={i.to} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-panel-2" title={i.title}>
                    <span className={clsx("chip shrink-0", labelOf(i.kind).chip)}>{labelOf(i.kind).label}</span>
                    {i.ref && <span className="shrink-0 font-mono text-xs text-muted">{i.ref}</span>}
                    <span className="truncate">{i.text}</span>
                    {i.byAgent && <span className="ml-auto shrink-0 text-xs text-agent" title="Agent work"><AgentIcon /></span>}
                    {i.meta && <span className="ml-auto shrink-0 text-xs text-muted">{i.meta}</span>}
                  </Link>
                </li>
              ))}
            </List>
            </div>
          )}
        </div>
      )}
    </Widget>
  );
}

const labelOf = (kind: AttentionKind) => ATTENTION_LABELS.find((l) => l.kind === kind)!;

export function RecentActivity() {
  const q = useWidget("recent");
  if (q.isPending) return <WidgetSkeleton title="Recent activity" height={160} />;
  if (q.isError) return <Failed title="Recent activity" query={q} />;
  return (
    <Widget title="Recent activity" subtitle="Across all teams">
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
                lead={u.teamKey}
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
                href={`/t/${x.teamKey}?t=${x.ref}`}
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
                href={`/t/${d.teamKey}/map?node=${d.nodeId}`}
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

/** Days as words: "today", "1 day", "9 days". */
const ago = (days: number) => (days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`);

/**
 * What matters most in this team, in the order to look at it: work that has sat longest in progress, what has waited longest
 * for review, agents that went quiet, decisions still only proposed. Only on a team's Overview.
 */
export function TeamFocus() {
  const q = useWidget("focus");
  const team = useDashboardTeam();
  if (q.isPending) return <WidgetSkeleton title="Focus" height={180} />;
  if (q.isError) return <Failed title="Focus" query={q} />;
  const f = q.data;
  const stuck = f.aging.length + f.waitingReview.length + f.quiet.length;
  const row = (t: { ref: string; title: string }, right: string, agent = false) => (
    <li key={t.ref}>
      <Link to={`/t/${team}?t=${t.ref}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
        <span className="shrink-0 font-mono text-xs text-muted">{t.ref}</span>
        <span className="truncate">{t.title}</span>
        {agent && <span className="shrink-0 text-xs text-agent" title="Agent work"><AgentIcon /></span>}
        <span className="ml-auto shrink-0 text-xs text-muted">{right}</span>
      </Link>
    </li>
  );
  return (
    <Widget title="Focus" subtitle="What to look at first in this team">
      {f.tickets === 0 ? (
        <Empty>
          No tickets yet. <Link className="text-accent" to={`/t/${team}`}>Add the first one on the board</Link>, and what needs attention will appear here.
        </Empty>
      ) : stuck === 0 ? (
        <Empty>Nothing is stuck: no work waiting on review, nothing in progress for long, no agent gone quiet.</Empty>
      ) : (
        <div className="space-y-4">
          <AttentionSection title="Waiting longest for review" count={f.waitingReview.length}>
            {f.waitingReview.map((t) => row(t, ago(t.days), t.byAgent))}
          </AttentionSection>
          <AttentionSection title="In progress the longest" count={f.aging.length}>
            {f.aging.map((t) => row(t, ago(t.days), t.byAgent))}
          </AttentionSection>
          <AttentionSection title="Agents gone quiet" count={f.quiet.length}>
            {f.quiet.map((t) => row(t, `${t.agent}, ${timeAgo(t.lastAt)}`, true))}
          </AttentionSection>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 text-xs text-muted">
        <Link to={`/t/${team}/decisions`} className="hover:text-accent">
          {f.proposedDecisions} decision{f.proposedDecisions === 1 ? "" : "s"} still proposed
        </Link>
        <Link to={`/t/${team}/members`} className="hover:text-accent">
          {f.members.count} member{f.members.count === 1 ? "" : "s"}{f.members.myRole ? ` · you are ${f.members.myRole}` : ""}
        </Link>
      </div>
    </Widget>
  );
}
