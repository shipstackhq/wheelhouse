import "@/lib/core-host";
import Link from "next/link";
import clsx from "clsx";
import type { Actor } from "@/lib/auth";
import * as m from "@wheelhouse/core/lib/metrics";
import { timeAgo } from "@wheelhouse/core/lib/time";
import { SessionGroups } from "@/components/session-row";
import { Tip } from "@/components/tip";
import { LimitedSection, SECTION_LIMIT, TwoLineRow } from "@/components/dashboard/limited-list";
import { ActivityRow } from "@/components/dashboard/activity-row";
import { CollapsibleList } from "@/components/collapsible-list";
import { List } from "@/components/list";
import { SessionRemoveButton } from "@/components/session-remove-button";
import { Empty, StatTile, Widget } from "@/components/dashboard/widget";
import { StageBar, StageLegend } from "@/components/dashboard/stage-bar";
import { ColumnChart } from "@/components/dashboard/column-chart";
import { markAllSeenAction } from "@/app/actions";
import { SubmitButton } from "@/components/submit-button";

/**
 * Dashboard widgets. Each is an async server component that fetches its own
 * data (via lib/metrics) and renders inside <Widget>. To add one: write the
 * metric, write the component here, register it in ./registry.tsx.
 */

export type WidgetProps = { actor: Actor };

export async function KpiRow({ actor }: WidgetProps) {
  const s = await m.summary(actor);
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
      <StatTile label="Stale docs" value={s.staleDocs} hint="possibly out of date" href="/dashboard" />
      <StatTile label="Agents connected" value={s.agents} hint="active API keys" href="/agents" />
    </div>
  );
}

export async function ProjectProgress({ actor }: WidgetProps) {
  const ps = await m.projectProgress(actor);
  const names = ps.find((p) => p.stages.length)?.stages.map((s) => s.name) ?? [];
  return (
    <Widget title="Project progress" subtitle="Tickets per column; done = the last column" action={names.length ? <StageLegend names={names} /> : undefined}>
      {ps.length === 0 ? (
        <Empty>
          No projects yet. <Link className="text-accent" href="/projects/new">Create one</Link>.
        </Empty>
      ) : (
        <List inset="card" density="roomy">
          {ps.map((p) => (
            <li key={p.id}>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link href={`/p/${p.key}`} className="flex items-center gap-2 hover:text-accent">
                  <span className="chip bg-accent/15 font-mono text-accent">{p.key}</span>
                  <span className="font-medium">{p.name}</span>
                </Link>
                <span className="text-sm">
                  <b>{Math.round(p.pct * 100)}%</b> <span className="text-muted">done · {p.done}/{p.total}</span>
                </span>
                <span className="ml-auto flex flex-wrap gap-3 text-xs text-muted">
                  {p.urgent > 0 && <span className="text-danger">▲ {p.urgent} high/urgent</span>}
                  {p.agentReady > 0 && <span className="text-agent">🤖 {p.agentReady} AI-ready</span>}
                  {p.staleNodes > 0 && (
                    <Link href={`/p/${p.key}/map`} className="text-warn hover:underline">⚠ {p.staleNodes} stale</Link>
                  )}
                  {p.staleDocs > 0 && (
                    <Link href={`/p/${p.key}/docs`} className="text-warn hover:underline">⚠ {p.staleDocs} stale doc{p.staleDocs === 1 ? "" : "s"}</Link>
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

export async function Throughput({ actor }: WidgetProps) {
  const data = await m.throughput(actor, 14);
  return (
    <Widget title="Throughput" subtitle="Tickets created vs completed per day, last 14 days">
      <ColumnChart
        label="Tickets created and completed per day"
        data={data}
        series={[
          { key: "created", label: "Created", color: "var(--series-1)" },
          { key: "completed", label: "Completed", color: "var(--series-2)" },
        ]}
      />
    </Widget>
  );
}

export async function ActivitySplit({ actor }: WidgetProps) {
  const data = await m.activityByActor(actor, 14);
  return (
    <Widget title="Who's doing the work" subtitle="All board and map changes per day, by teammates vs agents">
      <ColumnChart
        stacked
        label="Changes per day by teammates and agents"
        data={data}
        series={[
          { key: "human", label: "Teammates", color: "var(--series-1)" },
          { key: "agent", label: "Agents", color: "var(--series-2)" },
        ]}
      />
    </Widget>
  );
}

export async function AgentQueues({ actor }: WidgetProps) {
  const agents = await m.agentQueues(actor);
  return (
    <Widget title="Agents" subtitle="Changes each agent hasn't picked up yet" action={<Link href="/agents" className="text-xs text-muted hover:text-fg">Manage →</Link>}>
      {agents.length === 0 ? (
        <Empty>
          No agents connected. <Link className="text-accent" href="/agents">Create an API key</Link>.
        </Empty>
      ) : (
        <List inset="card" className="text-sm">
          {agents.map((a) => (
            <li key={a.id} className="flex items-start gap-3">
              <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", a.pending ? "bg-agent" : "bg-ok")} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">🤖 {a.name}</div>
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
                    <form action={markAllSeenAction}>
                      <input type="hidden" name="keyId" value={a.id} />
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

export async function NeedsAttention({ actor }: WidgetProps) {
  const a = await m.needsAttention(actor);
  const empty = !a.review.length && !a.urgent.length && !a.stale.length && !a.staleDocs.length;
  return (
    <Widget title="Needs attention" subtitle="Where a human is the bottleneck">
      {empty ? (
        <Empty>Nothing waiting on you. 🎉</Empty>
      ) : (
        <div className="space-y-4">
          <AttentionSection title="Waiting for review" count={a.review.length}>
            {a.review.map((t) => (
              <li key={t.ref}>
                <Link href={`/p/${t.projectKey}?t=${t.ref}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
                  <span className="shrink-0 font-mono text-xs text-muted">{t.ref}</span>
                  <span className="truncate">{t.title}</span>
                  {t.byAgent && <span className="ml-auto shrink-0 text-xs text-agent" title="Agent work">🤖</span>}
                </Link>
              </li>
            ))}
          </AttentionSection>
          <AttentionSection title="Urgent" count={a.urgent.length}>
            {a.urgent.map((t) => (
              <li key={t.ref}>
                <Link href={`/p/${t.projectKey}?t=${t.ref}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
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
                <Link href={`/p/${n.projectKey}/map?node=${n.id}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2" title={n.reason ?? undefined}>
                  <span className="shrink-0 text-xs text-warn">⚠</span>
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
                <Link href={`/p/${d.projectKey}/docs?doc=${d.id}`} className="flex gap-2 rounded px-1 py-0.5 hover:bg-panel-2" title={d.reason ?? undefined}>
                  <span className="shrink-0 text-xs text-warn">⚠</span>
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

export async function RecentActivity({ actor }: WidgetProps) {
  const es = await m.recentActivity(actor, 25);
  return (
    <Widget title="Recent activity" subtitle="Across all projects">
      {es.length === 0 ? (
        <Empty>Nothing in the last 4 weeks.</Empty>
      ) : (
        <CollapsibleList limit={SECTION_LIMIT} title="Recent activity">
          {es.map((e) => (
            <ActivityRow key={e.seq} e={e} />
          ))}
        </CollapsibleList>
      )}
    </Widget>
  );
}

export async function SyncHealth({ actor }: WidgetProps) {
  const h = await m.syncHealth(actor);
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
            row={(q) => (
              <TwoLineRow
                key={q.ref}
                href={`/p/${q.projectKey}?t=${q.ref}`}
                lead={q.ref}
                title={q.title}
                meta={`🤖 ${q.agent} · ${timeAgo(q.lastAt)}`}
                tip={
                  <div className="space-y-0.5">
                    <div className="font-medium">
                      {q.ref} {q.title}
                    </div>
                    <div className="text-muted">
                      Claimed by {q.agent}; its last activity on it was {timeAgo(q.lastAt)}
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
