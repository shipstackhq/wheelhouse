import clsx from "clsx";
import { Link } from "react-router";
import { TrendDownIcon, TrendFlatIcon, TrendUpIcon } from "../icons";

/** Card frame every dashboard widget renders inside. */
export function Widget(props: { title: string; subtitle?: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={clsx("card flex min-w-0 flex-1 flex-col p-4", props.className)}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{props.title}</h2>
          {props.subtitle && <p className="mt-0.5 text-xs text-muted">{props.subtitle}</p>}
        </div>
        {props.action}
      </header>
      <div className="min-w-0 flex-1">{props.children}</div>
    </section>
  );
}

export function WidgetSkeleton({ title, className, height = 160 }: { title: string; className?: string; height?: number }) {
  return (
    <section className={clsx("card flex min-w-0 flex-1 flex-col p-4", className)} aria-busy>
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3 flex-1 animate-pulse rounded-md bg-panel-2" style={{ minHeight: height }} />
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="flex h-full min-h-24 items-center justify-center py-6 text-center text-sm text-muted">{children}</p>;
}

/** Stat tile: label · value · optional delta vs a named period. */
export function StatTile(props: {
  label: string;
  value: string | number;
  delta?: { value: number; period: string; upIsGood?: boolean } | null;
  hint?: string;
  href?: string;
}) {
  const d = props.delta;
  const good = d ? (d.value === 0 ? null : (d.value > 0) === (d.upIsGood ?? true)) : null;
  const body = (
    <>
      <div className="text-xs text-muted">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold">{props.value}</div>
      {d ? (
        <div className={clsx("mt-1 text-xs", good === null ? "text-muted" : good ? "text-ok" : "text-danger")}>
          {d.value > 0 ? <TrendUpIcon /> : d.value < 0 ? <TrendDownIcon /> : <TrendFlatIcon />} {d.value > 0 ? "+" : ""}
          {d.value} <span className="text-muted">vs {d.period}</span>
        </div>
      ) : (
        props.hint && <div className="mt-1 text-xs text-muted">{props.hint}</div>
      )}
    </>
  );
  return props.href ? (
    <Link to={props.href} className="card block p-4 hover:border-muted/60">{body}</Link>
  ) : (
    <div className="card h-full p-4">{body}</div>
  );
}
