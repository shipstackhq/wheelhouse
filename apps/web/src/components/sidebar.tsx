import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Popover } from "radix-ui";
import { Link, useLocation, useNavigate } from "react-router";
import clsx from "clsx";
import { NAV_ICON, NAV_ICON_RAIL, NAV_ITEM, NAV_ITEM_RAIL, NavLink } from "./nav-link";
import { AddIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, CollapseSidebarIcon, ExpandSidebarIcon, MenuIcon, MoreFillIcon, NAV_ICONS, SearchIcon, TeamGlyphIcon, type IconPair } from "./icons";
import { Tip } from "./tip";
import { WorkspaceSwitcher } from "./workspace-switcher";

type TeamItem = { key: string; name: string };

const SECTIONS: { group: string; items: { path: string; label: string; icon: IconPair }[] }[] = [
  {
    group: "Work",
    items: [
      { path: "/overview", label: "Overview", icon: NAV_ICONS.overview },
      { path: "", label: "Board", icon: NAV_ICONS.board },
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
  { group: "Code", items: [{ path: "/repos", label: "Repos", icon: NAV_ICONS.repos }] },
  {
    group: "Team",
    items: [
      { path: "/members", label: "Team members", icon: NAV_ICONS.teamMembers },
      { path: "/settings", label: "Team settings", icon: NAV_ICONS.teamSettings },
    ],
  },
];

/** A team's sections fade in and out, quickly. `MotionConfig reducedMotion="user"` (in the app root) turns it off for people who ask the OS for less motion. */
const fade = { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: 0.12, ease: "easeOut" } }, exit: { opacity: 0, transition: { duration: 0.08, ease: "easeIn" } } } as const;

/** A team's icon colour: one of a fixed set, picked from its key so it is the same on every visit and for everyone. */
const TEAM_COLORS = ["text-sky-500", "text-emerald-500", "text-amber-500", "text-rose-500", "text-violet-500", "text-teal-500", "text-orange-500", "text-fuchsia-500", "text-lime-500", "text-indigo-500"];
const teamColor = (key: string) => TEAM_COLORS[[...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % TEAM_COLORS.length];

const RECENT_KEY = "wh:recent-teams";
const COLLAPSED_KEY = "wh:sidebar-collapsed";

/** Whether the person last left the sidebar as the icon-only rail. Storage can be blocked or empty: then it is open. */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
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
  isAdmin,
  profile,
}: {
  teams: TeamItem[];
  workspaceName: string;
  isAdmin: boolean;
  /** The account menu; a function gets whether the sidebar is the icon-only rail, so it can draw itself compact. */
  profile: React.ReactNode | ((collapsed: boolean) => React.ReactNode);
}) {
  const { pathname: path } = useLocation();
  const navigate = useNavigate();
  const match = path.match(/^\/t\/([^/]+)/);
  const currentKey = match ? decodeURIComponent(match[1]) : null;
  const current = teams.find((p) => p.key === currentKey) ?? null;
  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(readCollapsed); // the icon-only rail, tablet and up
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* the choice just is not remembered */
      }
      return !c;
    });
  const [openTeams, setOpenTeams] = useState<string[]>(() => (currentKey ? [currentKey] : []));
  const toggleTeam = (key: string) => setOpenTeams((o) => (o.includes(key) ? o.filter((k) => k !== key) : [...o, key]));
  // Going to a team (from a link, the search, the address bar) opens it; opening or closing one by hand never navigates.
  useEffect(() => {
    if (currentKey) setOpenTeams((o) => (o.includes(currentKey) ? o : [...o, currentKey]));
  }, [currentKey]);
  const [teamsClosed, toggleTeamsClosed] = useFolded("Teams");
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
      <button
        type="button"
        aria-label="Open menu"
        onClick={() => setOpen(true)}
        className="fixed left-2 top-2 z-30 rounded-md border border-line bg-panel px-2 py-1 text-sm md:hidden"
      >
        <MenuIcon className="text-lg" />
      </button>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)} />}
      <aside
        id="app-sidebar"
        data-collapsed={collapsed ? "true" : "false"}
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex w-56 shrink-0 flex-col border-r border-line bg-panel transition-transform md:static md:translate-x-0 md:transition-[width]",
          collapsed && "md:w-14",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className={clsx("flex items-center justify-between px-3 py-3", collapsed && "md:flex-col md:gap-3 md:px-0")}>
          <WorkspaceSwitcher name={workspaceName} collapsed={collapsed} />
          <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="text-muted md:hidden">
            <CloseIcon className="text-lg" />
          </button>
          <Tip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right" align="center">
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar"
              className="hidden rounded-md p-1 text-lg text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 md:inline-flex"
            >
              {collapsed ? <ExpandSidebarIcon /> : <CollapseSidebarIcon />}
            </button>
          </Tip>
        </div>
        <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 text-sm">
          <NavLink href="/" icon={NAV_ICONS.home} collapsed={collapsed}>Home</NavLink>
          <Group title="Workspace" collapsed={collapsed} gap="mt-3">
            <NavLink href="/initiatives" prefix icon={NAV_ICONS.initiatives} collapsed={collapsed}>Initiatives</NavLink>
            <NavLink href="/projects" prefix icon={NAV_ICONS.projects} collapsed={collapsed}>Projects</NavLink>
            <NavLink href="/workspace" icon={NAV_ICONS.people} collapsed={collapsed}>Members</NavLink>
            <NavLink href="/agents" icon={NAV_ICONS.agents} collapsed={collapsed}>Agents &amp; API keys</NavLink>
          </Group>
          <div className={clsx("relative", collapsed ? "md:mt-3 md:border-t md:border-line md:pt-3" : "")}>
            <div className={clsx("mt-5 flex items-center justify-between", collapsed && "md:mt-0 md:justify-center")}>
              <button
                type="button"
                onClick={toggleTeamsClosed}
                aria-expanded={!teamsClosed}
                aria-controls="group-teams"
                className={clsx("flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1 text-left text-xs font-medium leading-5 text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50", collapsed && "md:hidden")}
              >
                <span className="min-w-0 flex-1 truncate">Teams</span>
                <ChevronDownIcon className={clsx("shrink-0 text-base transition-transform", teamsClosed && "-rotate-90")} />
              </button>
              <span className="flex items-center gap-1">
                {(() => {
                  const search = (
                    <button
                      type="button"
                      onClick={() => setSwitcher(true)}
                      aria-label="Search teams (⌘K)"
                      className={clsx("rounded p-1 text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50", collapsed && "md:p-2")}
                    >
                      <SearchIcon className={clsx("text-base", collapsed && "md:text-xl")} />
                    </button>
                  );
                  return collapsed ? (
                    <Tip content="Search teams (⌘K)" side="right" align="center">
                      {search}
                    </Tip>
                  ) : (
                    search
                  );
                })()}
                <Link to="/teams/new" aria-label="Create a team" className={clsx("rounded p-1 text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50", collapsed && "md:hidden")}>
                  <AddIcon className="text-base" />
                </Link>
              </span>
            </div>
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
            {teams.map((t) => {
              const here = t.key === current?.key;
              const isOpen = openTeams.includes(t.key);
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
                    onClick={() => toggleTeam(t.key)}
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
                    <TeamGlyphIcon aria-hidden className={clsx(NAV_ICON, collapsed && NAV_ICON_RAIL, teamColor(t.key))} />
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
                <div key={t.key}>
                  {collapsed ? (
                    <Tip content={t.name} side="right" align="center">
                      {row}
                    </Tip>
                  ) : (
                    row
                  )}
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        key="sections"
                        id={`team-${t.key}`}
                        {...fade}
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
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
          {isAdmin && (
            <Group title="Admin" collapsed={collapsed} gap="mt-5">
              <NavLink href="/admin/workspaces" icon={NAV_ICONS.workspaces} collapsed={collapsed}>Workspaces</NavLink>
              <NavLink href="/admin/invites" icon={NAV_ICONS.inviteWorkspace} collapsed={collapsed}>Invite a new workspace</NavLink>
            </Group>
          )}
          <div className={clsx("mt-5", collapsed && "md:mt-3 md:border-t md:border-line md:pt-3")}>
            <NavLink href="/settings" icon={NAV_ICONS.settings} collapsed={collapsed}>Settings</NavLink>
          </div>
        </nav>
        <div className="border-t border-line p-2">{typeof profile === "function" ? profile(collapsed) : profile}</div>
      </aside>
    </>
  );
}

const GROUPS_KEY = "wh:sidebar-closed-groups";

function readClosedGroups(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * A titled group of links that folds away from its title (the choice is remembered). The title row is the same size as a link row.
 * As the rail the title goes (it would not fit), the links always show, and a thin rule separates the groups instead.
 */
/** Whether a titled section is folded, remembered per title. */
function useFolded(title: string) {
  const [closed, setClosed] = useState(() => readClosedGroups().includes(title));
  const toggle = () =>
    setClosed((c) => {
      try {
        const rest = readClosedGroups().filter((g) => g !== title);
        localStorage.setItem(GROUPS_KEY, JSON.stringify(c ? rest : [...rest, title]));
      } catch {
        /* the choice just is not remembered */
      }
      return !c;
    });
  return [closed, toggle] as const;
}

function Group({ title, collapsed, gap, children }: { title: string; collapsed: boolean; gap: string; children: React.ReactNode }) {
  const [closed, toggle] = useFolded(title);
  const id = `group-${title.toLowerCase()}`;
  return (
    <div className={clsx(collapsed && "md:mt-3 md:border-t md:border-line md:pt-3")}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!closed}
        aria-controls={id}
        className={clsx(
          "flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-xs font-medium leading-5 text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50",
          gap,
          collapsed && "md:hidden",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <ChevronDownIcon className={clsx("shrink-0 text-base transition-transform", closed && "-rotate-90")} />
      </button>
      <div id={id} className={clsx("mt-0.5 space-y-0.5", closed && "hidden", closed && collapsed && "md:block")}>
        {children}
      </div>
    </div>
  );
}
