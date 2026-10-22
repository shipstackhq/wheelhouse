import { useEffect, useMemo, useRef, useState } from "react";
import { Reorder, useDragControls } from "motion/react";
import { Popover } from "radix-ui";
import { Link, useLocation, useNavigate } from "react-router";
import clsx from "clsx";
import { NAV_ICON, NAV_ICON_RAIL, NAV_ITEM, NAV_ITEM_RAIL, NavLink } from "./nav-link";
import { AddIcon, ChevronRightIcon, MoreFillIcon, NAV_ICONS, SearchIcon, type IconPair } from "./icons";
import { SectionLabel, SidebarCloseButton, SidebarFrame, SidebarGroup, useFolded } from "./sidebar-frame";
import { useServices } from "../lib/services";
import { TeamIcon } from "./team-icon";
import { Tip } from "./tip";
import { WorkspaceSwitcher } from "./workspace-switcher";

type TeamItem = { key: string; name: string; icon?: string | null; iconColor?: string | null };

const SECTIONS: { group: string; items: { path: string; label: string; icon: IconPair }[] }[] = [
  {
    group: "Work",
    items: [
      { path: "/overview", label: "Overview", icon: NAV_ICONS.overview },
      { path: "", label: "Issues", icon: NAV_ICONS.issues },
      { path: "/cycles", label: "Cycles", icon: NAV_ICONS.cycles },
      { path: "/activity", label: "Activity", icon: NAV_ICONS.activity },
    ],
  },
  {
    group: "Knowledge",
    items: [
      { path: "/map", label: "Map", icon: NAV_ICONS.map },
      { path: "/docs", label: "Docs", icon: NAV_ICONS.docs },
      { path: "/decisions", label: "Decisions", icon: NAV_ICONS.decisions },
      { path: "/glossary", label: "Glossary", icon: NAV_ICONS.glossary },
    ],
  },
  {
    group: "Team",
    items: [
      { path: "/members", label: "Team members", icon: NAV_ICONS.teamMembers },
      { path: "/settings", label: "Team settings", icon: NAV_ICONS.teamSettings },
    ],
  },
];

/** How rows slide into place while a team is dragged: a stiff, well-damped spring, so they settle at once instead of wobbling. */
const reorderSpring = { type: "spring", stiffness: 900, damping: 50, mass: 0.5 } as const;

/** A sidebar row that is a button rather than a link (no place to go yet). Same size and look as a link; the rail shows its icon and a tooltip. */
function NavButton({ icon, collapsed = false, children }: { icon: IconPair; collapsed?: boolean; children: React.ReactNode }) {
  const Icon = icon.line;
  const button = (
    <button
      type="button"
      className={clsx(NAV_ITEM, collapsed && NAV_ITEM_RAIL, "w-full text-muted hover:bg-panel-2 hover:text-fg")}
    >
      <Icon className={clsx(NAV_ICON, collapsed && NAV_ICON_RAIL)} />
      <span className={clsx("min-w-0 flex-1 truncate text-left", collapsed && "md:sr-only")}>{children}</span>
    </button>
  );
  return collapsed ? (
    <Tip content={children} side="right" align="center">
      {button}
    </Tip>
  ) : (
    button
  );
}

const RECENT_KEY = "wh:recent-teams";
const LAST_COOKIE = "wh_last_team";

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function currentSection(path: string, key: string): string {
  const rest = path.slice(`/t/${key}`.length);
  const first = rest.split("/").filter(Boolean)[0];
  return first ? `/${first}` : "";
}

export function Sidebar({
  teams,
  workspaceName,
  workspaceImageUrl,
  isAdmin,
  profile,
  collapsed,
}: {
  teams: TeamItem[];
  workspaceName: string;
  workspaceImageUrl?: string | null;
  isAdmin: boolean;
  /** The icon-only rail, tablet and up. The app's header holds the toggle. */
  collapsed: boolean;
  /** The account menu; a function gets whether the sidebar is the icon-only rail, so it can draw itself compact. */
  profile: React.ReactNode | ((collapsed: boolean) => React.ReactNode);
}) {
  const { pathname: path } = useLocation();
  const navigate = useNavigate();
  const match = path.match(/^\/t\/([^/]+)/);
  const currentKey = match ? decodeURIComponent(match[1]) : null;
  const current = teams.find((p) => p.key === currentKey) ?? null;
  const [open, setOpen] = useState(false); // mobile drawer
  const [openTeams, setOpenTeams] = useState<string[]>(() => (currentKey ? [currentKey] : []));
  const toggleTeam = (key: string) => setOpenTeams((o) => (o.includes(key) ? o.filter((k) => k !== key) : [...o, key]));
  // Going to a team (from a link, the search, the address bar) opens it; opening or closing one by hand never navigates.
  useEffect(() => {
    if (currentKey) setOpenTeams((o) => (o.includes(currentKey) ? o : [...o, currentKey]));
  }, [currentKey]);
  const [teamsClosed, toggleTeamsClosed] = useFolded("Teams");
  // The person's own order of their teams: the server's, until they drag one. Kept in step with the server after each drop.
  const { api, queryClient } = useServices();
  const [orderKeys, setOrderKeys] = useState<string[] | null>(null);
  const latest = useRef<string[]>([]);
  const signature = teams.map((t) => t.key).join(",");
  useEffect(() => setOrderKeys(null), [signature]);
  const shown = orderKeys ? orderKeys.map((k) => teams.find((t) => t.key === k)).filter((t): t is TeamItem => !!t) : teams;
  const reorder = (keys: string[]) => {
    latest.current = keys;
    setOrderKeys(keys);
  };
  const saveOrder = () => {
    const keys = latest.current;
    if (!keys.length || keys.join(",") === signature) return;
    api.teams
      .reorder(keys)
      .then(() => queryClient.invalidateQueries({ queryKey: ["teams"] }))
      .catch(() => setOrderKeys(null)); // not saved: back to the order the server has
  };
  const move = (key: string, delta: -1 | 1) => {
    const keys = shown.map((t) => t.key);
    const i = keys.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    reorder(keys);
    saveOrder();
  };
  const [switcher, setSwitcher] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Remember the team being viewed (recents + cookie), and close the drawer after navigating.
  useEffect(() => {
    setOpen(false);
    if (!currentKey || !current) return;
    const next = [currentKey, ...readRecent().filter((k) => k !== currentKey)].slice(0, 5);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {}
    document.cookie = `${LAST_COOKIE}=${encodeURIComponent(currentKey)}; path=/; max-age=31536000; samesite=lax`;
    setRecent(next);
  }, [currentKey, current]);

  useEffect(() => setRecent(readRecent()), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcher((v) => !v);
      } else if (e.key === "Escape") setSwitcher(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (switcher) {
      setQuery("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [switcher]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) return teams.filter((p) => p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q));
    const byKey = new Map(teams.map((p) => [p.key, p]));
    const rec = recent.map((k) => byKey.get(k)).filter((p): p is TeamItem => !!p);
    return [...rec, ...teams.filter((p) => !rec.includes(p))];
  }, [query, teams, recent]);

  function go(p: TeamItem) {
    // Keep the current section when the new team has it; every section exists for every team today.
    const section = currentKey ? currentSection(path, currentKey) : "";
    const known = SECTIONS.some((g) => g.items.some((i) => i.path === section));
    setSwitcher(false);
    navigate(`/t/${p.key}${known ? section : ""}`);
  }

  return (
    <>
      <SidebarFrame id="app-sidebar" open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} collapsed={collapsed}>
        <div className={clsx("flex items-center justify-between px-3 py-3", collapsed && "md:flex-col md:gap-3 md:px-0")}>
          <WorkspaceSwitcher name={workspaceName} imageUrl={workspaceImageUrl} collapsed={collapsed} />
          <SidebarCloseButton onClose={() => setOpen(false)} />
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 text-sm">
          {/* The main items space themselves like the links in a section. The last three are placeholders: buttons with nothing behind them yet. */}
          <div className="space-y-0.5">
            <NavLink href="/" icon={NAV_ICONS.home} collapsed={collapsed}>Home</NavLink>
            <NavButton icon={NAV_ICONS.inbox} collapsed={collapsed}>Inbox</NavButton>
            <NavButton icon={NAV_ICONS.agent} collapsed={collapsed}>Agent</NavButton>
            <NavButton icon={NAV_ICONS.myIssues} collapsed={collapsed}>My issues</NavButton>
          </div>
          <SidebarGroup title="Workspace" collapsed={collapsed} gap="mt-3">
            <NavLink href="/initiatives" prefix icon={NAV_ICONS.initiatives} collapsed={collapsed}>Initiatives</NavLink>
            <NavLink href="/projects" prefix icon={NAV_ICONS.projects} collapsed={collapsed}>Projects</NavLink>
            <NavLink href="/workspace" icon={NAV_ICONS.people} collapsed={collapsed}>Members</NavLink>
            <NavLink href="/agents" icon={NAV_ICONS.agents} collapsed={collapsed}>Agents &amp; API keys</NavLink>
          </SidebarGroup>
          <div className={clsx("relative", collapsed ? "md:mt-3 md:border-t md:border-line md:pt-3" : "")}>
            <SectionLabel
              title="Teams"
              closed={teamsClosed}
              onToggle={toggleTeamsClosed}
              controls="group-teams"
              collapsed={collapsed}
              gap="mt-5"
              actions={
                <>
                  <button type="button" onClick={() => setSwitcher(true)} aria-label="Search teams (⌘K)" className="rounded p-1 text-muted outline-none hover:bg-panel hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50">
                    <SearchIcon className="text-base" />
                  </button>
                  <Link to="/teams/new" aria-label="Create a team" className="rounded p-1 text-muted outline-none hover:bg-panel hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50">
                    <AddIcon className="text-base" />
                  </Link>
                </>
              }
            />
            {collapsed && (
              <div className="hidden md:flex md:justify-center">
                <Tip content="Search teams (⌘K)" side="right" align="center">
                  <button type="button" onClick={() => setSwitcher(true)} aria-label="Search teams (⌘K)" className="rounded p-2 text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50">
                    <SearchIcon className="text-xl" />
                  </button>
                </Tip>
              </div>
            )}
            {switcher && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSwitcher(false)} />
                <div className={clsx("absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-line bg-panel p-1 shadow-lg", collapsed && "md:fixed md:left-16 md:right-auto md:top-24 md:mt-0 md:w-72")}>
                  <input
                    ref={inputRef}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setCursor(0);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setCursor((c) => Math.min(c + 1, results.length - 1));
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setCursor((c) => Math.max(c - 1, 0));
                      } else if (e.key === "Enter" && results[cursor]) go(results[cursor]);
                    }}
                    placeholder="Search teams…"
                    className="mb-1 w-full rounded bg-panel-2 px-2 py-1 text-sm outline-none"
                  />
                  <div role="listbox" aria-label="Teams" className="max-h-64 overflow-y-auto">
                    {!query && recent.length > 0 && <div className="px-2 py-1 text-[11px] text-muted">Recent</div>}
                    {results.map((p, i) => (
                      <button
                        key={p.key}
                        type="button"
                        role="option"
                        aria-selected={i === cursor}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => go(p)}
                        className={clsx("flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left", i === cursor && "bg-panel-2")}
                      >
                        <span className="truncate">{p.name}</span>
                        <span className="font-mono text-[11px] text-muted">{p.key}</span>
                      </button>
                    ))}
                    {results.length === 0 && <div className="px-2 py-1.5 text-muted">No teams match.</div>}
                  </div>
                  <Link
                    to="/teams/new"
                    onClick={() => setSwitcher(false)}
                    className="mt-1 block rounded border-t border-line px-2 py-1.5 text-muted hover:bg-panel-2 hover:text-fg"
                  >
                    + New team
                  </Link>
                </div>
              </>
            )}
          </div>
          <div id="group-teams" className={clsx("mt-0.5 space-y-0.5", teamsClosed && "hidden", teamsClosed && collapsed && "md:block")}>
            {teams.length === 0 && <p className={clsx("px-2 py-1.5 text-xs text-muted", collapsed && "md:hidden")}>No teams yet. Teams you are a member of appear here.</p>}
            <Reorder.Group as="div" axis="y" values={shown.map((t) => t.key)} onReorder={reorder} className="space-y-0.5">
              {shown.map((t) => (
                <TeamRow
                  key={t.key}
                  t={t}
                  here={t.key === current?.key}
                  isOpen={openTeams.includes(t.key)}
                  collapsed={collapsed}
                  dragEnabled={!collapsed}
                  onToggle={() => toggleTeam(t.key)}
                  onMove={(d) => move(t.key, d)}
                  onDragEnd={saveOrder}
                />
              ))}
            </Reorder.Group>
          </div>
          {isAdmin && (
            <SidebarGroup title="Admin" collapsed={collapsed} gap="mt-5">
              <NavLink href="/admin/workspaces" icon={NAV_ICONS.workspaces} collapsed={collapsed}>Workspaces</NavLink>
              <NavLink href="/admin/invites" icon={NAV_ICONS.inviteWorkspace} collapsed={collapsed}>Invite a new workspace</NavLink>
            </SidebarGroup>
          )}
          <div className={clsx("mt-5", collapsed && "md:mt-3 md:border-t md:border-line md:pt-3")}>
            <NavLink href="/settings" icon={NAV_ICONS.settings} collapsed={collapsed}>Settings</NavLink>
          </div>
        </nav>
        <div className="border-t border-line p-2">{typeof profile === "function" ? profile(collapsed) : profile}</div>
      </SidebarFrame>
    </>
  );
}

/** One team in the sidebar: its row (a toggle, with a three-dot menu) and, when open, its sections. A row is dragged by its toggle (a mouse or pen; Alt+Up and Alt+Down do the same from the keyboard). */
function TeamRow({ t, here, isOpen, collapsed, dragEnabled, onToggle, onMove, onDragEnd }: { t: TeamItem; here: boolean; isOpen: boolean; collapsed: boolean; dragEnabled: boolean; onToggle: () => void; onMove: (delta: -1 | 1) => void; onDragEnd: () => void }) {
  const controls = useDragControls();
  const row = (
    <div
      className={clsx(
        "group flex items-center rounded-md",
        collapsed && "md:justify-center",
        here ? "text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
          onPointerDown={dragEnabled ? (e) => e.pointerType !== "touch" && controls.start(e) : undefined}
          onKeyDown={(e) => {
            if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
              e.preventDefault();
              onMove(e.key === "ArrowUp" ? -1 : 1);
            }
          }}
          title={collapsed ? undefined : "Drag to reorder, or Alt+Up and Alt+Down"}
        aria-expanded={isOpen}
        aria-controls={`team-${t.key}`}
        aria-label={collapsed ? t.name : undefined}
        className={clsx(
          NAV_ITEM,
          "min-w-0 flex-1 text-left",
          collapsed && ["md:flex-none", NAV_ITEM_RAIL],
          here && "font-medium",
        )}
      >
        {/* A placeholder for the team's own icon, which a team will be able to choose later. */}
        <TeamIcon team={t} className={clsx(NAV_ICON, collapsed && NAV_ICON_RAIL)} />
        <span className={clsx("min-w-0 truncate", collapsed && "md:hidden")}>{t.name}</span>
        <ChevronRightIcon aria-hidden className={clsx("shrink-0 text-sm text-muted transition-transform duration-150", isOpen && "rotate-90", collapsed && "md:hidden")} />
        <span className="flex-1" aria-hidden />
      </button>
      <Popover.Root>
        <Popover.Trigger
          aria-label={`Options for ${t.name}`}
          className={clsx(
            "mr-1 shrink-0 rounded p-1 text-muted outline-none hover:bg-panel hover:text-fg focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:opacity-100 md:opacity-0 md:group-hover:opacity-100",
            collapsed && "md:hidden",
          )}
        >
          <MoreFillIcon aria-hidden className="text-base" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="right" align="start" sideOffset={6} collisionPadding={8} className="z-50 w-52 rounded-lg border border-line bg-panel p-3 text-sm text-muted shadow-xl">
            Options for {t.name} will go here.
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
  return (
      <Reorder.Item as="div" value={t.key} layout="position" dragListener={false} dragControls={controls} onDragEnd={onDragEnd} whileDrag={{ zIndex: 20 }} transition={reorderSpring} dragTransition={{ bounceStiffness: 900, bounceDamping: 50 }} className="relative">
      {collapsed ? (
        <Tip content={t.name} side="right" align="center">
          {row}
        </Tip>
      ) : (
        row
      )}
        {isOpen && (
          <div
            id={`team-${t.key}`}
            className={clsx("ml-3 border-l border-line pl-1.5", collapsed && "md:ml-0 md:border-0 md:pl-0")}
          >
            <div className="mt-0.5 space-y-2">
              {SECTIONS.map((g) => (
                <div key={g.group} className={clsx("space-y-0.5", collapsed && "md:border-t md:border-line md:pt-1")}>
                  {g.items.map((i) => (
                    <NavLink key={i.path} href={`/t/${t.key}${i.path}`} prefix={i.path !== ""} icon={i.icon} collapsed={collapsed}>
                      {i.label}
                    </NavLink>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </Reorder.Item>
  );
}

/**
 * The title row of a sidebar section: the label with its arrow right beside it (click to fold), and the section's own actions at the
 * end of the row (shown on hover or focus on wide screens). Not drawn in the icon-only rail, which has no room for titles.
 */
