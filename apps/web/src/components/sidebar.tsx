import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import clsx from "clsx";
import { Logo, WheelIcon } from "./logo";
import { NavLink } from "./nav-link";
import { CloseIcon, CollapseSidebarIcon, ExpandSidebarIcon, FolderIcon, MenuIcon, NAV_ICONS, type IconPair } from "./icons";
import { Tip } from "./tip";

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

/** The team last viewed, from the cookie this sidebar writes (the Next app read the same cookie on the server). */
export function readLastTeam(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${LAST_COOKIE}=([^;]*)`));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

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
  lastTeam,
  profile,
}: {
  teams: TeamItem[];
  workspaceName: string;
  isAdmin: boolean;
  /** The team to open from the logo; read from the cookie when not given. */
  lastTeam?: string | null;
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

  const last = lastTeam === undefined ? readLastTeam() : lastTeam; // re-read on each render: viewing a team writes the cookie
  const home = last && teams.some((p) => p.key === last) ? `/t/${last}` : "/";

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
        <div className={clsx("flex items-center justify-between px-4 py-4", collapsed && "md:flex-col md:gap-3 md:px-0")}>
          <Link to={home} aria-label="Wheelhouse" className="rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            <Logo className={clsx("text-sm", collapsed && "md:hidden")} compact />
            {collapsed && <WheelIcon size={26} className="hidden md:block" />}
          </Link>
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
        <div className={clsx("px-4 pb-2 text-xs text-muted", collapsed && "md:hidden")}>{workspaceName}</div>
        <nav className="flex-1 overflow-y-auto px-2 text-sm">
          <NavLink href="/" icon={NAV_ICONS.home} collapsed={collapsed}>Home</NavLink>
          <div className="relative mt-3">
            {(() => {
              const trigger = (
                <button
                  type="button"
                  onClick={() => setSwitcher(true)}
                  aria-label={collapsed ? (current ? `Team: ${current.name}` : "Select a team") : undefined}
                  className={clsx(
                    "flex w-full items-center justify-between gap-2 rounded-md border border-line px-2 py-1.5 text-left outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/50",
                    collapsed && "md:justify-center md:px-0 md:py-2",
                  )}
                >
                  {collapsed && <FolderIcon className="hidden shrink-0 text-xl md:block" />}
                  <span className={clsx("min-w-0 truncate", collapsed && "md:hidden")}>{current ? current.name : "Select a team"}</span>
                  <kbd className={clsx("font-mono text-[11px] text-muted", collapsed && "md:hidden")}>⌘K</kbd>
                </button>
              );
              return collapsed ? (
                <Tip content={current ? `${current.name} (⌘K)` : "Select a team (⌘K)"} side="right" align="center">
                  {trigger}
                </Tip>
              ) : (
                trigger
              );
            })()}
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
                  <div className="max-h-64 overflow-y-auto">
                    {!query && recent.length > 0 && <div className="px-2 py-1 text-[11px] text-muted">Recent</div>}
                    {results.map((p, i) => (
                      <button
                        key={p.key}
                        type="button"
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
          {current &&
            SECTIONS.map((g) => (
              <Group key={g.group} title={g.group} collapsed={collapsed} gap="mt-4">
                {g.items.map((i) => (
                  <NavLink key={i.path} href={`/t/${current.key}${i.path}`} prefix={i.path !== ""} icon={i.icon} collapsed={collapsed}>
                    {i.label}
                  </NavLink>
                ))}
              </Group>
            ))}
          <Group title="Workspace" collapsed={collapsed} gap="mt-5">
            <NavLink href="/workspace" icon={NAV_ICONS.people} collapsed={collapsed}>Members</NavLink>
            <NavLink href="/agents" icon={NAV_ICONS.agents} collapsed={collapsed}>Agents &amp; API keys</NavLink>
          </Group>
          {isAdmin && (
            <Group title="Admin" collapsed={collapsed} gap="mt-5">
              <NavLink href="/admin/workspaces" icon={NAV_ICONS.workspaces} collapsed={collapsed}>Workspaces</NavLink>
              <NavLink href="/admin/invites" icon={NAV_ICONS.inviteWorkspace} collapsed={collapsed}>Invite a new workspace</NavLink>
            </Group>
          )}
        </nav>
        <div className="border-t border-line p-2">{typeof profile === "function" ? profile(collapsed) : profile}</div>
      </aside>
    </>
  );
}

/** A titled group of links. As the rail the title goes (it would not fit) and a thin rule separates the groups instead. */
function Group({ title, collapsed, gap, children }: { title: string; collapsed: boolean; gap: string; children: React.ReactNode }) {
  return (
    <div className={clsx(collapsed && "md:mt-3 md:border-t md:border-line md:pt-3")}>
      <div className={clsx("label px-2 normal-case tracking-normal", gap, collapsed && "md:hidden")}>{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
