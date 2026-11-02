import type { ComponentProps, ComponentType, ReactElement, ReactNode } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Link } from "../lib/workspace";
import { ChevronRightIcon } from "./icons";

/**
 * The app's menu: a Radix dropdown (keyboard navigation, submenus, focus handling) with one look. Items sit a little apart,
 * `MenuSeparator` divides it, `MenuLabel` names a section (optional), and `MenuSub` opens a second menu beside the first.
 *
 *   <Menu trigger={<button>…</button>}>
 *     <MenuItem icon={SettingsIcon} href="/settings">Settings</MenuItem>
 *     <MenuSeparator />
 *     <MenuLabel>Workspaces</MenuLabel>
 *     <MenuSub label="More"><MenuItem onSelect={…}>One</MenuItem></MenuSub>
 *   </Menu>
 */
const BOX = "z-60 flex min-w-44 flex-col gap-0.5 rounded-lg border border-line bg-panel p-1 text-fg shadow-xl";
const ROW = "flex w-full cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none data-[highlighted]:bg-fg/[0.07] data-[disabled]:pointer-events-none data-[disabled]:opacity-40";

type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/** The menu around its `trigger` (one element, which keeps its own look). `side`/`align`/`className` shape where and how wide it opens. */
export function Menu({ trigger, children, side, align = "start", className, ...root }: { trigger: ReactElement; children: ReactNode; side?: "top" | "right" | "bottom" | "left"; align?: "start" | "center" | "end"; className?: string } & Omit<ComponentProps<typeof DropdownMenu.Root>, "children">) {
  return (
    <DropdownMenu.Root modal={false} {...root}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side={side} align={align} sideOffset={6} collisionPadding={8} className={clsx(BOX, className)}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One choice. With `href` it is a link (to a path written as elsewhere in the app); otherwise `onSelect` runs. `danger` is for the destructive one. */
export function MenuItem({ icon: Icon, href, danger, className, children, ...item }: { icon?: Icon; href?: string; danger?: boolean; className?: string; children: ReactNode } & Omit<ComponentProps<typeof DropdownMenu.Item>, "asChild" | "children">) {
  const classes = clsx(ROW, danger && "text-danger", className);
  const content = (
    <>
      {Icon && <Icon aria-hidden className="shrink-0 text-base" />}
      {children}
    </>
  );
  return (
    <DropdownMenu.Item asChild={!!href} className={classes} {...item}>
      {href ? <Link to={href}>{content}</Link> : content}
    </DropdownMenu.Item>
  );
}

/** A group of items under an optional label, so a screen reader hears what they are. */
export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Group aria-label={label} className="flex flex-col gap-0.5">
      {children}
    </DropdownMenu.Group>
  );
}

/** The name of a section, in small muted text. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-2 pb-0.5 pt-1.5 text-xs text-muted">{children}</DropdownMenu.Label>;
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-0.5 h-px bg-line" />;
}

/** An item that opens a second menu to its side. */
export function MenuSub({ label, icon: Icon, className, children }: { label: string; icon?: Icon; className?: string; children: ReactNode }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={clsx(ROW, "justify-between data-[state=open]:bg-fg/[0.07]")}>
        <span className="flex items-center gap-2.5">
          {Icon && <Icon aria-hidden className="shrink-0 text-base" />}
          {label}
        </span>
        <ChevronRightIcon aria-hidden className="text-sm text-muted" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent sideOffset={4} collisionPadding={8} className={clsx(BOX, className)}>
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
