import { useQuery } from "@tanstack/react-query";
import { Popover } from "radix-ui";
import clsx from "clsx";
import { useNavigate } from "react-router";
import { useServices } from "../lib/services";
import { ChevronDownIcon } from "./icons";

/**
 * The workspace, as a round icon with its initial and a down arrow, at the top of the sidebar. It opens a menu of the person's
 * workspaces; choosing another moves this session there and drops everything read from the old one (every team, project and key
 * is the other workspace's). With a single workspace the menu just names it. `collapsed` is the icon-only rail.
 */
export function WorkspaceSwitcher({ name, collapsed = false }: { name: string; collapsed?: boolean }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["me", "workspaces"] as const, queryFn: () => api.workspaces.list() });
  const list = query.data ?? [];
  const go = async (id: string) => {
    try {
      await api.workspaces.switchTo(id);
    } catch {
      return; // not offered any more (removed, suspended): the list refreshes on the next open
    }
    queryClient.clear();
    navigate("/", { replace: true });
  };
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Workspace menu: ${name}`}
        title={name}
        className={clsx(
          "group flex shrink-0 items-center gap-0.5 rounded-full py-0.5 pl-0.5 pr-1 text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-panel-2 data-[state=open]:text-fg",
          collapsed && "md:pr-0.5",
        )}
      >
        <span aria-hidden className="grid size-5 place-items-center rounded-full bg-accent/15 text-[10px] font-semibold uppercase text-accent">
          {name.trim().charAt(0) || "W"}
        </span>
        <ChevronDownIcon aria-hidden className="text-sm transition-transform group-data-[state=open]:rotate-180" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side={collapsed ? "right" : "bottom"} align="start" sideOffset={6} collisionPadding={8} className="z-50 w-60 rounded-lg border border-line bg-panel p-1 text-fg shadow-xl">
          <div role="group" aria-label="Workspaces">
            <div className="px-2 py-1 text-xs text-muted">Workspaces</div>
            {(list.length ? list : [{ id: "current", name, role: "", active: true }]).map((w) => (
              <button
                key={w.id}
                type="button"
                disabled={w.active}
                aria-current={w.active ? "true" : undefined}
                onClick={() => go(w.id)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-panel-2 focus-visible:bg-panel-2 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className={clsx("truncate", w.active ? "font-medium text-fg" : "text-muted")}>{w.name}</span>
                <span className="shrink-0 text-xs text-muted">{w.active ? "current" : w.role}</span>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
