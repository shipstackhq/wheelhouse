import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, Popover } from "radix-ui";
import clsx from "clsx";
import { useNavigate, wsKey } from "../lib/workspace";
import { useServices } from "../lib/services";
import { ApiError } from "@wheelhouse/api-client";
import { describeFailure } from "../lib/form-state";
import { ChevronDownIcon } from "./icons";
import { SubmitButton } from "./submit-button";

/**
 * The workspace, as a round icon with its initial and a down arrow, at the top of the sidebar. It opens a menu of the person's
 * workspaces (personal first); choosing another opens it (its own address, so its own cache) and tells the server it is the last one used.
 * Ctrl/Cmd+1...9 choose the first nine. "Create workspace" opens a small dialog. With a single workspace the menu just names it. `collapsed` is the icon-only rail, where the arrow is hidden and only the icon stays.
 */
export function WorkspaceSwitcher({ name, imageUrl, collapsed = false }: { name: string; imageUrl?: string | null; collapsed?: boolean }) {
  const { api } = useServices();
  const navigate = useNavigate();
  // Keyed by workspace: the server marks the current one by the workspace asked for, so each needs its own read.
  const query = useQuery({ queryKey: wsKey(api, "workspaces"), queryFn: () => api.workspaces.list() });
  const list = query.data ?? [];
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const go = async ({ id, slug }: { id: string; slug: string }) => {
    try {
      await api.workspaces.switchTo(id);
    } catch {
      return; // not offered any more (removed, suspended): the list refreshes on the next open
    }
    navigate(`/w/${slug}`);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const w = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key) ? list[Number(e.key) - 1] : undefined;
      if (!w || w.active) return;
      e.preventDefault();
      void go(w);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`Workspace menu: ${name}`}
        title={name}
        className={clsx(
          "group flex shrink-0 items-center gap-0.5 rounded-full py-0.5 pl-0.5 pr-1 text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-panel-2 data-[state=open]:text-fg",
          collapsed && "md:gap-0 md:pr-0.5", // in the icon-only rail the arrow goes and only the icon stays
        )}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="" aria-hidden className="size-5 rounded-full object-cover" />
        ) : (
          <span aria-hidden className="grid size-5 place-items-center rounded-full bg-accent/15 text-[10px] font-semibold uppercase text-accent">
            {name.trim().charAt(0) || "W"}
          </span>
        )}
        <ChevronDownIcon aria-hidden className={clsx("text-sm transition-transform group-data-[state=open]:rotate-180", collapsed && "md:hidden")} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side={collapsed ? "right" : "bottom"} align="start" sideOffset={6} collisionPadding={8} className="z-50 w-60 rounded-lg border border-line bg-panel p-1 text-fg shadow-xl">
          <div role="group" aria-label="Workspaces">
            <div className="px-2 py-1 text-xs text-muted">Workspaces</div>
            {(list.length ? list : [{ id: "current", slug: "", name, role: "", active: true }]).map((w) => (
              <button
                key={w.id}
                type="button"
                disabled={w.active}
                aria-current={w.active ? "true" : undefined}
                onClick={() => go(w)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-panel-2 focus-visible:bg-panel-2 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className={clsx("truncate", w.active ? "font-medium text-fg" : "text-muted")}>{w.name}</span>
                <span className="shrink-0 text-xs text-muted">{w.active ? "current" : w.role}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCreating(true);
              }}
              className="mt-1 flex w-full items-center rounded-md border-t border-line px-2 py-1.5 text-left text-sm text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2"
            >
              Create workspace
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Name and address of a new workspace; the address follows the name until typed. The server's field errors show under the field. */
function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { api } = useServices();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string | null>(null); // null: still following the name
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = async () => {
    try {
      const w = await api.workspaces.create({ name, slug: slug ?? undefined });
      await api.workspaces.switchTo(w.id);
      onOpenChange(false);
      setName("");
      setSlug(null);
      navigate(`/w/${w.slug}`);
    } catch (e) {
      setErrors(e instanceof ApiError && e.fields ? e.fields : { form: describeFailure(e) });
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(94vw,380px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl">
          <Dialog.Title className="font-semibold">Create workspace</Dialog.Title>
          <Dialog.Description className="sr-only">A new team workspace that you own.</Dialog.Description>
          <form action={submit} className="mt-3 space-y-3">
            <div>
              <label className="text-xs text-muted" htmlFor="ws-name">Name</label>
              <input id="ws-name" className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={100} />
              {errors.name && <p className="mt-1 text-xs text-danger">{errors.name}</p>}
            </div>
            <div>
              <label className="text-xs text-muted" htmlFor="ws-slug">Address</label>
              <input id="ws-slug" className="input mt-1" value={slug ?? slugOf(name)} onChange={(e) => setSlug(e.target.value)} maxLength={40} />
              {errors.slug && <p className="mt-1 text-xs text-danger">{errors.slug}</p>}
            </div>
            {errors.form && <p className="text-xs text-danger">{errors.form}</p>}
            <div className="flex justify-end gap-2">
              <Dialog.Close className="btn" type="button">Cancel</Dialog.Close>
              <SubmitButton className="btn btn-primary">Create</SubmitButton>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
