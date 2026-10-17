import { Link, useParams, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { timeAgo } from "@wheelhouse/core/lib/time";
import { Loaded } from "../../components/query-state";
import { activityQuery } from "../../lib/queries";
import { useServices } from "../../lib/services";
import { AgentIcon } from "../../components/icons";

/** What happened in the project, newest first: everything, only agents, or only the team. Each line links to the thing it is about. */
export function ActivityPage() {
  const { key = "" } = useParams();
  const [search] = useSearchParams();
  const { api } = useServices();
  const who = search.get("who");
  const actorKind = who === "agent" || who === "human" ? who : undefined;
  const query = useQuery(activityQuery(api, key, actorKind));
  const tab = (v: "agent" | "human" | undefined, label: React.ReactNode) => (
    <Link to={v ? `?who=${v}` : { search: "" }} className={clsx("rounded-md px-3 py-1 text-sm", actorKind === v ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}>
      {label}
    </Link>
  );
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-4 flex gap-1">
          {tab(undefined, "Everything")}
          {tab("agent", <><AgentIcon /> Agents</>)}
          {tab("human", "Team")}
        </div>
        <Loaded query={query} label="Loading the activity">
          {(events) => (
            <>
              {events.length === 0 && <p className="text-sm text-muted">Nothing yet.</p>}
              <ul className="divide-y divide-line">
                {events.map((e) => {
                  const ref = e.data.ref ?? null;
                  return (
                    <li key={e.seq} className="flex items-baseline gap-3 py-2.5 text-sm">
                      <span className="w-14 shrink-0 font-mono text-[11px] text-muted/70">#{e.seq}</span>
                      <span className={clsx("shrink-0 font-medium", e.actorKind === "agent" && "text-agent")}>
                        {e.actorKind === "agent" && <AgentIcon />}{e.actorKind === "agent" && " "}
                        {e.actorName}
                      </span>
                      <span className="min-w-0 flex-1 text-muted">
                        {ref ? (
                          <Link to={`/p/${key}?t=${ref}`} className="hover:text-fg">{e.summary}</Link>
                        ) : e.entity === "node" ? (
                          <Link to={`/p/${key}/map?node=${e.entityId}`} className="hover:text-fg">{e.summary}</Link>
                        ) : e.entity === "edge" || e.entity === "flow" || e.type === "code.changed" ? (
                          <Link to={`/p/${key}/map${e.entity === "flow" ? `?flow=${e.entityId}` : ""}`} className="hover:text-fg">{e.summary}</Link>
                        ) : e.entity === "decision" ? (
                          <Link to={`/p/${key}/decisions#adr-${e.data.number ?? ""}`} className="hover:text-fg">{e.summary}</Link>
                        ) : e.entity === "term" ? (
                          <Link to={`/p/${key}/glossary`} className="hover:text-fg">{e.summary}</Link>
                        ) : (
                          e.summary
                        )}
                        {e.type === "comment.created" && typeof e.data.body === "string" && (
                          <span className="mt-1 block truncate text-xs text-muted/80">“{e.data.body}”</span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-muted/70">{timeAgo(e.createdAt)}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Loaded>
      </div>
    </div>
  );
}
