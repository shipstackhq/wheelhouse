import { useQuery } from "@tanstack/react-query";
import { Popover } from "radix-ui";
import clsx from "clsx";
import { useNavigate } from "react-router";
import { useServices } from "../lib/services";
import { ChevronDownIcon } from "./icons";
import { Tip } from "./tip";

/**
 * The workspace at the top of the sidebar: its name, and a menu of the person's workspaces. Choosing another moves this session
 * there and drops everything read from the old one (every team, project and key is the other workspace's). With a single workspace
 * the menu just names it. `collapsed` is the icon-only rail, where an initial stands in for the name.
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
  const trigger = (
    <Popover.Trigger
      aria-label={collapsed ? `Workspace: ${name}` : "Workspace menu"}
      className={clsx(
        "flex w-full items-center gap-2 rounded-md border border-line px-2 py-1.5 text-left outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-panel-2",
        collapsed && "md:justify-center md:px-0 md:py-2",
      )}
    >
      <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded bg-accent/15 text-[11px] font-semibold uppercase text-accent">
        {name.trim().charAt(0) || "W"}
      </span>
      <span className={clsx("min-w-0 flex-1 truncate font-medium", collapsed && "md:hidden")}>{name}</span>
      <ChevronDownIcon className={clsx("shrink-0 text-muted", collapsed && "md:hidden")} />
    </Popover.Trigger>
  );
  return (
    <Popover.Root>
      {collapsed ? (
        <Tip content={name} side="right" align="center">
          {trigger}
        </Tip>
      ) : (
        trigger
      )}
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
