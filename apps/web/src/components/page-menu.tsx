import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { MoreIcon } from "./icons";

/** One thing an open page offers in the header's "more actions" menu. */
export type PageMenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };

// Two contexts so a page that sets its items does not re-render for the change it made: the setter never changes.
const PageMenuItems = createContext<PageMenuItem[]>([]);
const PageMenuSetter = createContext<(items: PageMenuItem[]) => void>(() => {});

/** Holds what the open page has put in the header's menu. The signed-in app wraps its header and its pages in it. */
export function PageMenuProvider({ children }: { children: ReactNode }) {
  const [items, set] = useState<PageMenuItem[]>([]);
  return (
    <PageMenuSetter.Provider value={set}>
      <PageMenuItems.Provider value={items}>{children}</PageMenuItems.Provider>
    </PageMenuSetter.Provider>
  );
}

/**
 * A page's actions for the header's menu. They show while the page is open and are cleared when it closes. Pass a new list
 * whenever the actions change; an empty list hides the menu.
 */
export function usePageMenu(items: PageMenuItem[]) {
  const set = useContext(PageMenuSetter);
  useEffect(() => {
    set(items);
    return () => set([]);
  }, [items, set]);
}

/** The header's "more actions" button, at the end of the breadcrumbs. Nothing when the open page has no actions. */
export function PageMenu() {
  const items = useContext(PageMenuItems);
  if (!items.length) return null;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label="More actions"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted outline-none hover:bg-fg/[0.07] hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-fg/[0.07] data-[state=open]:text-fg"
      >
        <MoreIcon className="text-base" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className="z-60 min-w-40 rounded-lg border border-line bg-panel p-1 shadow-lg">
          {items.map((it) => (
            <DropdownMenu.Item
              key={it.label}
              disabled={it.disabled}
              onSelect={it.onSelect}
              className={clsx(
                "flex cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-fg/[0.07] data-[disabled]:opacity-40",
                it.danger ? "text-danger" : "text-fg",
              )}
            >
              {it.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
