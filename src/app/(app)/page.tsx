import { Suspense } from "react";
import Link from "next/link";
import { requireHuman } from "@/lib/auth";
import { WidgetSkeleton } from "@/components/dashboard/widget";
import { WIDGETS, SPAN_CLASS } from "./dashboard/registry";
import { DashboardRefresh } from "./dashboard/refresh";

export default async function Dashboard() {
  const { actor, user, team } = await requireHuman();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="h-full overflow-y-auto">
      <DashboardRefresh />
      <div className="mx-auto max-w-[1400px] px-6 py-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">
              {greeting}, {user.name.split(" ")[0]}
            </h1>
            <p className="mt-1 text-sm text-muted">How {team.name}&apos;s projects are moving, and what the agents are up to.</p>
          </div>
          <Link href="/projects/new" className="btn">+ New project</Link>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {WIDGETS.map(({ id, title, span, skeletonHeight, Component }) => (
            <div key={id} className={`${SPAN_CLASS[span]} flex flex-col`}>
              <Suspense fallback={<WidgetSkeleton title={title} height={skeletonHeight} />}>
                <Component actor={actor} />
              </Suspense>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
