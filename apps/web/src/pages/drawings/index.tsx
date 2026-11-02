import { useState, useTransition } from "react";
import { useParams } from "react-router";
import type { DrawingListItem } from "@wheelhouse/api-client";
import { Link, useNavigate } from "../../lib/workspace";
import { Loaded } from "../../components/query-state";
import { useDialogs } from "../../components/ui";
import { BrushIcon, EditIcon, SearchIcon } from "../../components/icons";
import { describeFailure } from "../../lib/form-state";
import { useDrawings } from "../../lib/queries";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";

/** `/t/:key/drawings`: the team's drawings as a grid of cards. This page never loads Excalidraw: a card shows the stored SVG preview. */
export function DrawingsPage() {
  const { key = "" } = useParams();
  const query = useDrawings(key);
  return (
    <Loaded query={query} label="Loading drawings">
      {(drawings) => <DrawingsGrid teamKey={key} drawings={drawings} />}
    </Loaded>
  );
}

const svgSrc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const edited = (d: DrawingListItem) => `Edited by ${d.updatedByName} on ${new Date(d.updatedAt).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })}`;

function DrawingsGrid({ teamKey, drawings }: { teamKey: string; drawings: DrawingListItem[] }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const { confirm, prompt, dialogs } = useDialogs();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = drawings.filter((d) => d.title.toLowerCase().includes(filter.trim().toLowerCase()));

  const run = (work: () => Promise<void>) =>
    start(async () => {
      try {
        await work();
        setError(null);
      } catch (e) {
        setError(describeFailure(e));
      }
      await refreshAll(queryClient);
    });

  const create = () =>
    run(async () => {
      const d = await api.drawings.create(teamKey, { title: "Untitled drawing" });
      void navigate(`/t/${teamKey}/drawings/${encodeURIComponent(d.id)}`);
    });
  const rename = async (d: DrawingListItem) => {
    const title = (await prompt({ title: "Rename drawing", placeholder: d.title, confirmLabel: "Rename" }))?.trim();
    if (title) run(async () => void (await api.drawings.update(teamKey, d.id, { title, version: d.version })));
  };
  const remove = async (d: DrawingListItem) => {
    if (await confirm({ title: `Delete “${d.title}”?`, confirmLabel: "Delete", danger: true })) run(async () => void (await api.drawings.delete(teamKey, d.id)));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-page">
      <section className="min-h-0 flex-1 overflow-y-auto">
        <div className="w-full px-4 py-8 sm:px-8 lg:py-12">
          <div className="mb-2 flex items-center justify-end gap-3">
            <h1 className="sr-only">Drawings</h1>
            {drawings.length > 0 && (
              <button className="btn btn-primary shrink-0" disabled={pending} onClick={create}>
                New drawing
              </button>
            )}
          </div>
          <p className="mb-6 text-sm text-muted">Whiteboards and diagrams your team and its agents can open and read.</p>
          {error && <p className="mb-4 text-sm text-danger" role="alert">{error}</p>}
          {drawings.length === 0 ? (
            <div className="rounded-md border border-dashed border-line p-8 text-center">
              <BrushIcon className="mx-auto mb-2 text-2xl text-muted" />
              <p className="text-sm text-muted">No drawings yet. A drawing is a sketch or diagram on a canvas, saved with this team and readable by its agents.</p>
              <button className="btn btn-primary mt-4" disabled={pending} onClick={create}>
                New drawing
              </button>
            </div>
          ) : (
            <>
              <div className="relative mb-4">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  type="search"
                  className="input !rounded-full !border-transparent !bg-panel-2/70 !py-1.5 !pl-9 text-sm focus:!border-accent"
                  placeholder="Search by name…"
                  aria-label="Search drawings by name"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              {shown.length === 0 ? (
                <p className="text-sm text-muted">No drawings match “{filter}”.</p>
              ) : (
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {shown.map((d) => (
                    <li key={d.id} className="group overflow-hidden rounded-md border border-line bg-panel">
                      <Link to={`/t/${teamKey}/drawings/${encodeURIComponent(d.id)}`} className="block" aria-label={`Open ${d.title}`}>
                        <div className="flex aspect-[4/3] items-center justify-center bg-white">
                          {d.thumbnail ? <img src={svgSrc(d.thumbnail)} alt="" className="max-h-full max-w-full object-contain" /> : <BrushIcon className="text-3xl text-muted" />}
                        </div>
                      </Link>
                      <div className="flex items-start justify-between gap-2 p-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{d.title}</p>
                          <p className="truncate text-xs text-muted">{edited(d)}</p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button className="btn btn-ghost px-2 py-1 text-xs" aria-label={`Rename ${d.title}`} disabled={pending} onClick={() => void rename(d)}>
                            <EditIcon />
                          </button>
                          <button className="btn btn-ghost px-2 py-1 text-xs text-danger" aria-label={`Delete ${d.title}`} disabled={pending} onClick={() => void remove(d)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </section>
      {dialogs}
    </div>
  );
}
